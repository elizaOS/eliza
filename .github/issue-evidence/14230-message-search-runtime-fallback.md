# PR #14230 - message search runtime fallback

## Scope

Added a real regression in `plugins/plugin-sql/src/__tests__/migration/message-search-production-guard.real.test.ts` for production Postgres startup with message-search DDL skipped. The test migrates with `NODE_ENV=production`, `ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS` unset, and `databaseBackend: "postgres"`, verifies `memories.message_search_document` is absent, seeds real message rows through the SQL adapter, then calls the real `adapter.searchMessages()` path.

## Runtime evidence

- Text recall query: `alpha-sentinel` returned the seeded message text `runtime fallback recalls alpha-sentinel text`.
- Attachment recall query: `incident-runbook-14230` returned the seeded message carrying `incident-runbook-14230.pdf`.
- Both result sets reported `ftsRank === 0` and `trigramSimilarity === 0`, matching the sequential fallback path.
- Logs showed `[MessageSearch] search objects are missing; falling back to sequential message search` for both runtime searches.

## Commands

```bash
bun run --cwd plugins/plugin-sql/src test:real:files __tests__/migration/message-search-production-guard.real.test.ts
```

Result: passed. Vitest reported `1 passed` file and `4 passed` tests.

```bash
bun run --cwd plugins/plugin-sql lint:check
```

Result: passed with exit code 0. Biome reported the existing `plugins/plugin-sql/src/biome.json` ignore-folder warnings only; no touched-file errors remained.

## Incomplete evidence

- Full repo `bun run verify` was not run; this was scoped to the requested plugin-sql regression and Biome check.
- No UI screenshots/video or live-LLM trajectories were produced; this change is a storage adapter regression test with no UI or model behavior.
- No live external Postgres run was performed; the regression uses the existing real PGlite migration harness while forcing the migration service's Postgres production guard branch.
