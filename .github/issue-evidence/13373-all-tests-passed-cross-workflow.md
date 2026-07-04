# Issue #13373 - All Tests Passed Cross-Workflow Aggregate

## Scope

Added `.github/workflows/all-tests-passed.yml`, a real `All Tests Passed`
check-run context that polls the existing protected PR contexts across
workflows:

- `Develop Gate (lint)`
- `Develop Gate (secret scan + UI determinism)`
- `Format + Type Safety Ratchet`
- `Homepage Build (PR smoke)`
- `gitleaks`
- `coverage on changed files`
- `check-pr-title`
- `stale-base guard`

The aggregate fails closed on missing, failed, cancelled, timed-out, or
incorrectly skipped checks. The only missing/skipped allowlist is the explicit
`Quality (Extended)` `paths-ignore` case when every changed file matches that
workflow's ignored paths.

## Local Verification

Run from isolated worktree `/tmp/eliza-13373-all-tests.yBis1T`:

- `actionlint .github/workflows/all-tests-passed.yml` - pass
- `node packages/scripts/all-tests-passed-workflow-contract.mjs` - pass
- `bunx @biomejs/biome check packages/scripts/all-tests-passed-workflow-contract.mjs` - pass
- `node packages/scripts/audit-scripts.mjs --json` - pass: `{"ok":true,"failures":[]}`
- `git diff --check` - pass

Full `bun run verify` was not run in this fresh isolated worktree because it has
no `node_modules`. The touched surface is CI YAML plus one dependency-free Node
contract script, covered by the focused checks above. The final proof is the
real PR check run emitted by GitHub Actions.

## Live GitHub API Check

Checked an active same-repo PR (#13370) to confirm the aggregate must poll the
PR head SHA, not the synthetic merge SHA:

- PR head `a5fb55f0b68e6bb786966d2c6da401179727c6e4`: check-runs API returned
  76 runs and included `Develop Gate (lint)`, `gitleaks`, and `check-pr-title`.
- PR synthetic merge `056bd395ef21fde2c0cd0fa69a88951cdb786bdc`: check-runs
  API returned 0 runs.
- PR head commit-status API returned only external `CodeRabbit`; Actions jobs
  are check runs, so the aggregate reads check runs first and statuses second.

## Evidence N/A

- UI screenshots/video: N/A - no product UI changes.
- Live model trajectories: N/A - no agent, prompt, model, provider, or action
  behavior changed.
- Backend/frontend logs: N/A - GitHub Actions workflow-only change.
