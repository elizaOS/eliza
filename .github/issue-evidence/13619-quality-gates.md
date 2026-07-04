# Issue #13619 — Orphaned Quality Gates

## Fix

Consolidated into PR #13640 rather than opening a competing CI-hardening PR.

- Removed the permanently-dead `audit:test-integrity:all` composite and the intentionally always-red `audit:test-integrity:no-vi-mocks` package script entry.
- Kept the already-wired `audit:focused-tests` gate as the canonical focused/skip guard on the develop quality path.
- Added a labeled `comment-cleanup` pull-request job in `quality.yml` that runs the comment-only diff guard self-test and then checks the PR diff.
- Wired the per-plugin keyless-e2e coverage self-test and ratchet into `scenario-pr.yml`.
- Renamed the surface coverage matrix report CLI from `packages/scripts/check-e2e-coverage.ts` to `packages/scripts/e2e-coverage/write-coverage-matrix-report.ts`, leaving `packages/scripts/e2e-coverage/check-e2e-coverage.ts` as the only file with that gate name.

## Verification

Static/local validation performed on the patched branch payload:

```bash
node -e 'JSON.parse(require("fs").readFileSync("/tmp/eliza-13619/package.json", "utf8")); console.log("package json ok")'
ruby -e 'require "yaml"; YAML.load_file("/tmp/eliza-13619/.github/workflows/quality.yml"); YAML.load_file("/tmp/eliza-13619/.github/workflows/scenario-pr.yml"); puts "workflow yaml ok"'
rg "audit:test-integrity:all|packages/scripts/check-e2e-coverage.ts" /tmp/eliza-13619/package.json /tmp/eliza-13619/.github/workflows /tmp/eliza-13619/packages/scripts/e2e-coverage
```

The moved report CLI could not be syntax-checked from the partial `/tmp` payload because `inventory.ts` resolves repo-relative imports. Full CI will run on PR #13640 after the branch update.

## Evidence Matrix

- CI wiring evidence: PR #13640 checks for `quality.yml` and `scenario-pr.yml`.
- Runtime/backend logs: N/A - workflow/script wiring only.
- UI screenshots/video: N/A - no rendered UI changed.
- Real LLM trajectories: N/A - no agent/action/prompt/model behavior changed.
