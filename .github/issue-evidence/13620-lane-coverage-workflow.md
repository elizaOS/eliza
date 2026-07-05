# Issue #13620 Lane Coverage Workflow Evidence

## Change

- Added a `Test Integrity (lane coverage)` job to `.github/workflows/develop-pr.yml`.
- The job runs `node packages/scripts/lint-lane-coverage.mjs` without `--dry-run`, so the seeded allowlist now produces a failing develop-PR workflow job instead of only printing advisory output in `ci.yaml`.
- The job is read-only and install-free: checkout, Node 24 setup, then the existing script.

## Local verification

- `node --check packages/scripts/lint-lane-coverage.mjs`
- `node packages/scripts/lint-lane-coverage.mjs` (PASS; 140 plugins scanned, 0 blocking issues, 153 suppressed issues)
- `ruby -e 'require "yaml"; YAML.load_file(".github/workflows/develop-pr.yml"); puts "develop-pr.yml parsed"'`
- `git diff --check`
- `bunx @biomejs/biome check .github/issue-evidence/13620-lane-coverage-workflow.md --no-errors-on-unmatched`

## Evidence matrix

- Real-LLM trajectories: N/A - workflow-only CI coverage wiring; no agent/action/provider/prompt/model behavior changed.
- Backend logs: N/A - no runtime backend path changed.
- Frontend screenshots/video: N/A - no user-facing UI changed.
- Domain artifacts: `.github/workflows/develop-pr.yml` now contains a non-`continue-on-error` lane coverage job for develop PRs.
