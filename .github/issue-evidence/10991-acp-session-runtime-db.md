# Issue 10991 - ACP Session Runtime DB

## Summary

`AcpSessionStore` now prefers the modern `runtime.adapter` property and falls
back to legacy `runtime.databaseAdapter`, matching the runtime shape used by
current elizaOS agents. The runtime DB backend also recognizes the eliza
`BaseDrizzleAdapter` shape (`adapter.db.execute`) in addition to older raw SQL
adapters.

The SQL backend now routes all reads/writes through a small executor abstraction
and uses portable `INSERT ... ON CONFLICT (id) DO UPDATE` upserts instead of
SQLite-only `INSERT OR REPLACE`, so the runtime DB path works for pglite,
Postgres, and modern SQLite.

## Verification

- `bunx biome check plugins/plugin-agent-orchestrator/src/services/session-store.ts plugins/plugin-agent-orchestrator/src/services/acp-service.ts plugins/plugin-agent-orchestrator/src/services/types.ts plugins/plugin-agent-orchestrator/__tests__/unit/session-store.test.ts`
  - Passed.
- `bunx vitest run --config vitest.config.ts __tests__/unit/session-store.test.ts`
  - Passed from `plugins/plugin-agent-orchestrator`: 1 file, 15 tests.
- `bun run --cwd plugins/plugin-agent-orchestrator typecheck`
  - Passed.

## Blocked / N/A

- A live ACP restart trajectory is N/A in this worktree because no live acpx
  subprocess/runtime container was running. The unit coverage exercises modern
  adapter selection, eliza drizzle-shaped adapter writes, legacy fallback, and
  portable upsert SQL.
