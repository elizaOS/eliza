# 13373 All Tests Passed Aggregate

## Change

- Added `.github/workflows/test.yml` job `all-tests-passed` with visible check
  name `All Tests Passed`.
- The job depends only on `ci-ok` and fails unless `ci-ok` succeeds, so it
  inherits the existing non-vacuous aggregate over server, client, XR, plugin,
  integration, desktop, zero-key, cloud-live, provider-live, and live-artifact
  validation lanes.
- Added script contract coverage so the exact check name and dependency on
  `ci-ok` cannot be removed silently.

## Local Verification

- `bun test packages/scripts/__tests__/test-task-pool.test.ts`
- `node packages/scripts/ci-workflow-dedup-contract.mjs`
- `bunx @biomejs/biome check .github/workflows/test.yml packages/scripts/__tests__/test-task-pool.test.ts packages/scripts/ci-workflow-dedup-contract.mjs .github/issue-evidence/13373-all-tests-passed.md`
- `git diff --check origin/develop...HEAD`

## Follow-Up

After this PR opens, the PR status rollup must show `All Tests Passed` as a real
GitHub check context before repo admins add it to ruleset `18511808`.
