const { spawnSync } = require("node:child_process");
const { TextDecoder } = require("node:util");

const maxBuffer = 100 * 1024 * 1024;
const pathDecoder = new TextDecoder("utf-8", { fatal: true });

function run(command, args, input) {
  const result = spawnSync(command, args, {
    encoding: null,
    input,
    maxBuffer,
  });

  if (result.error) {
    throw new Error(`Unable to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    throw new Error(`${command} failed${stderr ? `: ${stderr}` : ""}`);
  }

  return result.stdout;
}

function git(args) {
  return run("git", args);
}

function ghApi(method, endpoint, body) {
  const args = ["api", "--method", method, endpoint];
  let input;
  if (body !== undefined) {
    args.push("--input", "-");
    input = Buffer.from(JSON.stringify(body));
  }

  const output = run("gh", args, input).toString("utf8");
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`GitHub CLI returned invalid JSON for ${method} ${endpoint}.`);
  }
}

function splitNul(buffer) {
  const fields = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      fields.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== buffer.length) {
    throw new Error("Git returned malformed staged-change data.");
  }
  return fields;
}

function stagedChanges() {
  const fields = splitNul(
    git(["diff", "--cached", "--raw", "--no-renames", "--no-abbrev", "-z"]),
  );
  if (fields.length % 2 !== 0) {
    throw new Error("Git returned malformed staged-change data.");
  }

  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index].toString("ascii");
    const match = header.match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/);
    if (!match) {
      throw new Error(`Unable to parse staged change: ${header}`);
    }

    const [, oldMode, newMode, , newSha, status] = match;
    if (!["A", "M", "D", "T"].includes(status)) {
      throw new Error(`Unsupported staged change status: ${status}`);
    }

    let path;
    try {
      path = pathDecoder.decode(fields[index + 1]);
    } catch {
      throw new Error("A staged path is not valid UTF-8 and cannot be sent to GitHub.");
    }

    changes.push({ oldMode, newMode, newSha, path });
  }
  return changes;
}

function treeType(mode) {
  if (mode === "160000") {
    return "commit";
  }
  if (["100644", "100755", "120000"].includes(mode)) {
    return "blob";
  }
  throw new Error(`Unsupported staged file mode: ${mode}`);
}

function apiRef(repository, gitRef) {
  if (!gitRef.startsWith("refs/heads/") || gitRef.length === "refs/heads/".length) {
    throw new Error(`Expected ref input to be a branch ref, received: ${gitRef || "(empty)"}`);
  }

  const encodedRef = gitRef
    .slice("refs/".length)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `repos/${repository}/git/refs/${encodedRef}`;
}

function main() {
  if (!process.env.GH_TOKEN) {
    throw new Error("The token input must not be empty.");
  }

  const repository = process.env.TARGET_REPOSITORY;
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error("The repository input must contain an owner and repository name.");
  }

  const gitRef = process.env.TARGET_REF;
  const refEndpoint = apiRef(repository, gitRef || "");
  const changes = stagedChanges();
  if (changes.length === 0) {
    console.log("No staged changes; nothing to commit.");
    return;
  }

  const headSha = git(["rev-parse", "--verify", "HEAD"]).toString("utf8").trim();
  const baseTree = git(["rev-parse", "--verify", "HEAD^{tree}"]).toString("utf8").trim();
  const treeEntries = [];

  for (const change of changes) {
    if (change.newMode === "000000") {
      treeEntries.push({
        path: change.path,
        mode: change.oldMode,
        type: treeType(change.oldMode),
        sha: null,
      });
      continue;
    }

    const type = treeType(change.newMode);
    let sha = change.newSha;
    if (type === "blob") {
      const contents = git(["cat-file", "blob", change.newSha]);
      const blob = ghApi("POST", `repos/${repository}/git/blobs`, {
        content: contents.toString("base64"),
        encoding: "base64",
      });
      if (!blob.sha) {
        throw new Error(`GitHub did not return a blob SHA for ${change.path}.`);
      }
      sha = blob.sha;
    }

    treeEntries.push({
      path: change.path,
      mode: change.newMode,
      type,
      sha,
    });
  }

  const tree = ghApi("POST", `repos/${repository}/git/trees`, {
    base_tree: baseTree,
    tree: treeEntries,
  });
  if (!tree.sha) {
    throw new Error("GitHub did not return a tree SHA.");
  }

  const commit = ghApi("POST", `repos/${repository}/git/commits`, {
    message: process.env.COMMIT_MESSAGE || "Update staged files",
    tree: tree.sha,
    parents: [headSha],
  });
  if (!commit.sha) {
    throw new Error("GitHub did not return a commit SHA.");
  }

  const verification = commit.verification || {};
  const reason = verification.reason || "unknown";
  console.log(
    `GitHub signature verification for ${commit.sha}: verified=${verification.verified === true}, reason=${reason}.`,
  );

  const updatedRef = ghApi("PATCH", refEndpoint, {
    sha: commit.sha,
    force: false,
  });
  if (updatedRef.object?.sha !== commit.sha) {
    throw new Error(`GitHub did not update ${gitRef} to the new commit.`);
  }

  console.log(`Updated ${gitRef} to ${commit.sha}.`);
}

try {
  main();
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
}
