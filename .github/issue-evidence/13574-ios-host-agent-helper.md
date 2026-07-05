# Issue #13574 - iOS Host-Agent Helper

## Change

- Added `packages/app/scripts/lib/host-agent.mjs` to start
  `packages/app-core/scripts/serve-real-local-agent.ts`, choose a requested or
  free host port, wait for `/api/health`, write `host-agent.log`, and tear down
  on normal exit or SIGINT/SIGTERM.
- `ios-onboarding-smoke.mjs` and `ios-attachment-smoke.mjs` now start the
  deterministic host agent when `--api-base` is omitted. Passing `--api-base`
  still uses an externally managed API.
- `mobile-local-chat-smoke.mjs` now supports `--host-agent` for api-base-less
  remote API runs.
- `mobile-build-smoke.yml` now calls the script-owned lanes directly and keeps
  each `host-agent.log` under the existing uploaded `packages/app/test-results`
  directory.

## Verification

- PASS: `git fetch origin && git rebase origin/develop`
- PASS: `bun install`
- PASS: `node --check packages/app/scripts/lib/host-agent.mjs`
- PASS: `node --check packages/app/scripts/ios-onboarding-smoke.mjs`
- PASS: `node --check packages/app/scripts/ios-attachment-smoke.mjs`
- PASS: `node --check packages/app/scripts/mobile-local-chat-smoke.mjs`
- PASS:
  `bunx vitest run --config packages/app/vitest.config.ts packages/app/scripts/lib/host-agent.test.mjs`
  - 5 tests passed, including a subprocess health-server lifecycle check.
- PASS:
  `bunx @biomejs/biome check --write packages/app/scripts/lib/host-agent.mjs packages/app/scripts/lib/host-agent.test.mjs packages/app/scripts/ios-onboarding-smoke.mjs packages/app/scripts/ios-attachment-smoke.mjs packages/app/scripts/mobile-local-chat-smoke.mjs`
- PASS:
  `ruby -e 'require "yaml"; YAML.load_file(".github/workflows/mobile-build-smoke.yml"); puts "yaml ok"'`
- FAIL (unrelated repo ratchet): `bun run verify`
  - Failed in `audit:type-safety-ratchet` before this branch's script checks ran.
  - Reported existing ratchet deltas:
    - `as unknown as`: 74 current > 73 baseline
    - `?? []` in core/agent/app-core: 582 current > 581 baseline

## Not Run

- `bun run --cwd packages/app test:e2e:ios:onboarding`: not run in this
  worktree because the required installed iOS Simulator app/Xcode lane is not
  available in the current execution environment.
- Full `mobile-build-smoke.yml`: not run locally; intended to be validated by
  GitHub Actions on the PR.
