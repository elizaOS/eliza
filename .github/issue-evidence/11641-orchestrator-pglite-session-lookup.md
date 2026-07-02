# #11641 orchestrator pglite session lookup

PR: #11667

## Scope

Fixes the pglite/postgres failure where the orchestrator task store attempted
to locate a session with `document LIKE ?` against the serialized task document.
The fix uses the indexed `search_text` column as the portable prefilter, keeps
the JavaScript `sessions.find(...)` match authoritative, and leaves a full-scan
fallback only for legacy rows whose `search_text` does not yet include session
ids.

The service path also decouples a successful ACP spawn from durable
event-recording degradation, so `POST /tasks/{id}/agents` can return a coherent
2xx detail with the live session instead of a false 500.

## Verification

Run in `/home/shaw/eliza-worktrees/pr-11667-orchestrator-pglite` on 2026-07-02:

```bash
bun run --cwd plugins/plugin-agent-orchestrator test -- __tests__/unit/orchestrator-task-store.test.ts __tests__/unit/orchestrator-task-service.test.ts
./node_modules/.bin/tsgo --noEmit -p plugins/plugin-agent-orchestrator/tsconfig.json
bun run --cwd plugins/plugin-agent-orchestrator lint:check src/services/orchestrator-task-store.ts src/services/orchestrator-task-service.ts __tests__/unit/orchestrator-task-store.test.ts __tests__/unit/orchestrator-task-service.test.ts
git diff --check origin/develop...HEAD
git diff --check
```

Result:

- Focused unit tests: 2 files / 100 tests passed.
- Typecheck: passed.
- Biome: passed after formatting the new tests.
- Whitespace checks: passed.

## N/A

- Screenshots/video: N/A — backend persistence and API response semantics only.
- Live model trajectory: N/A — no model prompt/action/provider behavior changes.
