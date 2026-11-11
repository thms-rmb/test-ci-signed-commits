# Test signed commits in CI

In this repo I test how to sign commits in CI.

## Example workflows

The workflows are manually triggered with `workflow_dispatch`. In the GitHub Actions tab, select a workflow and the branch under **Use workflow from**, then choose **Run workflow**.

- **Update service-foo in dev** and **Update service-bar in dev** each increment the corresponding version file under `dev/` by one.
- **Promote dev to prod** copies both version files from `dev/` to `prod/`.

Each workflow stages its changes and uses the local `commit-staged-using-rest` action to create a commit and update the selected branch. The action reports GitHub's signature-verification result in the workflow log.
