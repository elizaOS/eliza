# Issue #11345 - TASKS History Filters

## Change

- `TASKS:history` now validates against the durable task service when ACP is absent, then consumes the advertised `window`, `statuses`, `search`, `limit`, and `includeArchived` parameters.
- Durable task history uses `OrchestratorTaskService.listTasks()` and applies status/window/search filters before applying `limit`.
- ACP session history fallback now applies the same supported status/window/search filters.
- Removed the unused `_inferStatuses`, `_inferWindow`, `_inferSearch`, `_buildWindowFilters`, and `_renderThreadLine` helpers by replacing them with called, parameter-driven helpers.

## Manual Review

- Reviewed the action schema: `search`, `window`, `statuses`, `limit`, and `includeArchived` remain advertised for `action=history`.
- Reviewed `runHistory`: planner-set filters flow into durable task listing, task DTO filtering, rendered output, and returned `data.filters`.
- Reviewed ACP fallback: when the durable task service is absent, session history still respects `statuses`, `search`, `window`, and `limit`.
- No UI, screenshot, video, live LLM trajectory, DB rows, migrations, wallet, or on-chain artifacts apply: this is an action-parameter behavior fix covered by unit tests.

## Verification

Passed:

```bash
bun run --cwd packages/core prebuild && bun run --cwd packages/core build:node
bunx vitest run --config vitest.config.ts __tests__/unit/task-history.test.ts --testTimeout 60000
bunx vitest run --config vitest.config.ts --testTimeout 60000
bun run --cwd plugins/plugin-agent-orchestrator typecheck
bun run --cwd plugins/plugin-agent-orchestrator build
bunx @biomejs/biome check plugins/plugin-agent-orchestrator/src/actions/tasks.ts plugins/plugin-agent-orchestrator/__tests__/unit/task-history.test.ts --no-errors-on-unmatched
git diff --check
```

Focused Vitest result: 1 file passed, 4 tests passed.

Full orchestrator package test result after rebase: 141 files passed, 3 skipped; 1427 tests passed, 6 skipped.

Known unrelated failures observed in this package/repo:

```bash
bun run --cwd plugins/plugin-agent-orchestrator lint:check
bun run verify
```

- Package-wide `lint:check` is currently blocked by pre-existing unrelated Biome findings outside the changed files.
- Root `bun run verify` is currently blocked at the repo type-safety ratchet baseline (`as unknown as` 80 > 77, `?? {}` 379 > 377). The changed files are not listed in the ratchet output.
