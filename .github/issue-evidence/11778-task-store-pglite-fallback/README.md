# Issue #11778 evidence: task-store pglite fallback

## Summary

`RuntimeDbTaskStore.findSession` now uses `CAST(document AS TEXT) AS document` for document reads, including the legacy full-table fallback used when older rows do not have session ids folded into `search_text`. This avoids the pglite/postgres failure shape `SELECT document FROM orchestrator_tasks` while preserving the legacy lookup path.

## Regression coverage

- Extended `PgliteLikeRejectingAdapter` so tests fail on both pglite-breaking shapes:
  - `document LIKE`
  - bare `SELECT document FROM orchestrator_tasks`
- Added a #11778 test that simulates an older persisted row whose `search_text` lacks the session id, forcing the legacy fallback. The fallback resolves the session without issuing the rejected query.

## Validation

- `bun run install:light` - pass.
- `bun test plugins/plugin-agent-orchestrator/__tests__/unit/orchestrator-task-store.test.ts` - pass, 40 tests, 133 assertions.
- Real `@electric-sql/pglite` smoke - pass. A task/session was persisted, `search_text` was manually rewritten to omit the session id, and `findSession("legacy-session-pglite")` returned:

```json
{"taskId":"955f78c1-2eb4-43eb-969f-9f2a366dafd2","sessionId":"legacy-session-pglite"}
```

- `bun run --cwd plugins/plugin-agent-orchestrator lint:check` - pass.
- `bun run --cwd packages/contracts build` - pass; prerequisite for typecheck.
- `bun run --cwd packages/shared build:i18n` - pass; generates shared/core i18n prerequisite.
- `bun run --cwd plugins/plugin-agent-orchestrator typecheck` - pass.
- `git diff --check` - pass.

## N/A

- App screenshots/video: N/A - backend task-store SQL lookup fix, no user-facing UI changed.
- Real LLM trajectories: N/A - no prompt, model, evaluator, or agent planning behavior changed.
- Backend service logs: N/A - this is a storage-layer query fix verified through unit coverage and a real pglite smoke; no long-running service was started.
