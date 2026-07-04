# 12909 script normalization tail evidence

Scope: normalized the remaining long-tail `plugins/*` package scripts to the
standard test/typecheck/lint/format contract, extended the convention guard to
enforce that contract, and fixed package-local test/config drift exposed by the
new real package test sweep.

## Verification

- `node packages/scripts/ensure-plugin-test-conventions.mjs --check`
  - Passed.
- Direct package test sweep for all 46 normalized packages:
  - `bun run --cwd <package> test`
  - Passed: 46 packages.
  - Failed: 0 packages.
  - Summary artifact:
    `.github/issue-evidence/12909-script-normalization-tail-tests.json`.
- `node packages/scripts/run-turbo.mjs run lint:check ...`
  - Passed: 46 successful, 46 total.
- `node packages/scripts/run-turbo.mjs run format:check ...`
  - Passed: 46 successful, 46 total.
- `node packages/scripts/run-turbo.mjs run typecheck ...`
  - Passed: 108 successful, 108 total.

## Evidence Matrix

- Screenshots/video: N/A - no `packages/app` UI or visual layout change; plugin
  DOM behavior changes are covered by package tests.
- Frontend console/network logs: N/A - no browser walkthrough surface changed.
- Backend logs: N/A - package script/test normalization only.
- Real-LLM trajectories: N/A - no agent/action/prompt/model behavior changed.
- Domain artifacts: N/A - no memories, DB rows, scheduled tasks, wallet, chain,
  or generated user files.
- Regression tests: included in the 46-package direct test sweep and the scoped
  Turbo lint/format/typecheck lanes above.
