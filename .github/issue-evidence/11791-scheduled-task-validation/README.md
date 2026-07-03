# Issue #11791 — scheduled-task structural validation

## Change

- Added shared pre-persistence validation for `ScheduledTask` inputs in `@elizaos/plugin-scheduling`.
- Validation now rejects malformed required fields, trigger variants, unregistered gates, malformed built-in gate params, unregistered completion checks, invalid output destinations, escalation channel/ladder shape, and invalid inline pipeline children before any row is written.
- REST schedule returns HTTP 400 for validation errors.
- PA `SCHEDULED_TASKS` create returns `INVALID_SCHEDULED_TASK` with issue details instead of throwing.
- PA integration config now includes the scheduled-task action integration file so this path is exercised by the package integration lane.

## Verification

```bash
bun run --cwd plugins/plugin-scheduling build
bun run --cwd plugins/plugin-scheduling typecheck
bun run --cwd plugins/plugin-scheduling lint
bunx vitest run --config plugins/plugin-scheduling/vitest.config.ts src/scheduled-task/runner.test.ts src/routes/scheduled-tasks.test.ts --reporter=dot
bun run --cwd plugins/plugin-personal-assistant lint:default-packs
bunx vitest run --config plugins/plugin-personal-assistant/vitest.src-integration.config.ts plugins/plugin-personal-assistant/test/scheduled-task-action.integration.test.ts --reporter=dot
git diff --check
bun install
bun run verify
```

Results:

- Scheduling focused runner/REST tests: 2 files passed, 67 tests passed.
- PA scheduled-task action integration: 1 file passed, 4 tests passed.
- PA default-pack lint: clean, 0 findings.
- Scheduling build, typecheck, lint, and `git diff --check`: passed.
- Post-rebase `bun install`: completed; artifact sync restored tracked side effects before PR.

## Known Non-Blocking Verification Output

`bun run verify` was run after rebasing on `origin/develop` and failed at `audit:type-safety-ratchet` before package typecheck/lint. The ratchet reports current `?? ""` usage in core/agent/app-core as `616 / 615`, with top contributors in `packages/core/src/services/message.ts`, `packages/agent/src/api/wallet-evm-balance.ts`, and other files outside this change.

`bun run --cwd plugins/plugin-personal-assistant typecheck` was run and failed on pre-existing package-wide issues outside this change, including unresolved workspace package types such as `@elizaos/shared`, `@elizaos/agent`, and multiple stale `../contracts/index.js` exports. The failure list is broad and not in the touched files.

## Evidence Matrix

- Real LLM trajectories: N/A - this change validates structural scheduled-task input after model/action output; no prompt/model behavior changed.
- Backend logs: N/A - focused unit/integration tests directly assert the backend persistence boundary and response shape.
- Frontend screenshots/video: N/A - no UI surface changed.
- Domain artifacts: covered by tests asserting rejected malformed runner, REST, and PA action inputs leave scheduled-task storage empty.
