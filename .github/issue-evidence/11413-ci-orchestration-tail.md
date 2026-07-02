# Issue 11413 CI orchestration tail

Date: 2026-07-02
Branch: `fix/11413-ci-orchestration-tail`

## Scope

Restored and reconciled the deferred CI orchestration tail from the #11271 stale-base squash:

- `.github/workflows/test.yml`: restored the personal-assistant integration lane and added it back to the aggregate `test-status` gate.
- `.github/workflows/scenario-pr.yml`: restored the explicit real/live guarded-suite manifest gate and UI fixture-runner coverage ratchet.
- `.github/workflows/kokoro-real-smoke.yml`: restored the post-#9588 F16 Kokoro smoke workflow comments, model path, and Linux espeak dependencies.
- `packages/scripts/run-all-tests.mjs`: restored post-merge real/live manifest drift checking and named accounting output.
- `packages/scripts/lib/real-live-suites.mjs`: restored the guarded real/live suite manifest and reconciled current `develop` drift by adding Birdclaw as a config-blocked real suite.
- `packages/scripts/__tests__/real-live-suites.test.ts`: restored the manifest honesty tests and updated the lane-conditional config detector for current SQL config spelling.
- `packages/scripts/__tests__/ui-e2e-runner-coverage.test.ts`: restored the UI e2e runner workflow ratchet.
- `.github/workflows/ui-e2e-gate.yml`: wired the nine currently orphaned `packages/ui` fixture runners into CI and added generated shared i18n setup required by the connectors runner.

No `lifeops-quality-bench.yml` restore was attempted: `packages/benchmarks/lifeops-quality` is absent on current `develop`, and the issue tail called out the CI orchestration files above for reconciliation instead of blind restoration.

## Verification

Dependency setup:

- `bun install --ignore-scripts --no-frozen-lockfile`: passed. This rewrote `bun.lock`; the lockfile side effect was reverted because it is unrelated to this fix.
- `bunx playwright install chromium`: passed.
- `node packages/app-core/scripts/ensure-shared-i18n-data.mjs`: passed and generated ignored local i18n artifacts for e2e validation.

Restored script gates:

- `bun test packages/scripts/__tests__/real-live-suites.test.ts`: passed, 7 tests.
- `bun test packages/scripts/__tests__/ui-e2e-runner-coverage.test.ts`: passed, 1 test.
- `node --check packages/scripts/run-all-tests.mjs`: passed.
- `TEST_LANE=post-merge node packages/scripts/run-all-tests.mjs --plan=text --no-cloud`: passed. It printed the restored named accounting: 4 armed, 19 missing-creds, 7 opt-in gated, 10 host-probed, 8 config-blocked real/live suites, then printed the post-merge plan.
- `bunx @biomejs/biome check packages/scripts/run-all-tests.mjs packages/scripts/lib/real-live-suites.mjs packages/scripts/__tests__/real-live-suites.test.ts packages/scripts/__tests__/ui-e2e-runner-coverage.test.ts`: exited 0. Biome still reports 13 existing `noUndeclaredEnvVars` warnings in `run-all-tests.mjs`.
- `git diff --check`: passed.

Newly wired UI fixture runners:

- `bun run --cwd packages/ui test:agent-surface-e2e`: passed.
- `bun run --cwd packages/ui test:ftu-home-e2e`: passed.
- `bun run --cwd packages/ui test:orchestrator-accounts-e2e`: passed.
- `bun run --cwd packages/ui test:background-e2e`: passed.
- `bun run --cwd packages/ui test:connectors-e2e`: initially failed before generated shared i18n setup; after adding the workflow setup step, passed.
- `bun run --cwd packages/ui test:bottombar-e2e`: passed.
- `bun run --cwd packages/ui test:chat-ambient-e2e`: passed.
- `bun run --cwd packages/ui test:fused-wake-integration-e2e`: skipped with `libwakeword not built`, matching the runner's host-capability skip behavior.
- `bun run --cwd packages/ui test:view-lifecycle-e2e`: passed.

Root verification:

- `bun run verify`: failed before typecheck/lint at the pre-existing type-safety ratchet drift on current `develop`:
  - `as unknown as: 80 current > 77 baseline`
  - ``?? {}`` core/agent/app-core: `379 current > 377 baseline`

## N/A evidence

- Live model trajectories: N/A - no agent prompt, action, provider, or model behavior changed.
- Backend/frontend runtime logs from a deployed app: N/A - this change restores CI workflow/script orchestration and runs isolated local CI/e2e scripts.
- Before/after app screenshots and app audit: N/A - no app UI source behavior changed; the validation used the isolated `packages/ui` fixture e2e runners that this PR wires into CI.
