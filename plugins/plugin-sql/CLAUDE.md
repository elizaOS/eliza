# @elizaos/plugin-sql

SQL database adapter plugin for elizaOS — provides persistent storage via PostgreSQL or embedded PGlite (WASM), with Drizzle ORM, automatic schema migrations, and optional Row Level Security.

## Purpose / role

This plugin registers a `DatabaseAdapter` with the elizaOS agent runtime so that all core runtime persistence (memories, entities, rooms, tasks, cache, logs, relationships, etc.) works against a real SQL backend. It is the default database plugin; elizaOS agents load it automatically if no other adapter is already registered. On Node/Bun it selects PostgreSQL when `POSTGRES_URL` is set, otherwise falls back to embedded PGlite. In the browser build it always uses PGlite (WASM).

## Plugin surface

The exported `plugin` object (`src/index.ts` / `src/index.node.ts` / `src/index.browser.ts`) registers:

| Kind | Name | Description |
|------|------|-------------|
| Service | `AdvancedMemoryStorageService` (`serviceType = "memoryStorage"`) | Implements `MemoryStorageProvider`; persists long-term memories and session summaries to dedicated SQL tables via the runtime memory API |
| Schema | `schema` (all tables) | Passed as `plugin.schema` so `DatabaseMigrationService` can auto-migrate at startup |

No actions, providers, evaluators, routes, or event handlers are registered by this plugin.

## Layout

```
plugins/plugin-sql/
  package.json                  npm manifest; scripts, deps
  README.md                     human-facing docs
  src/
    index.ts                    Default entry (same implementation as index.node.ts; uses ./utils)
    index.node.ts               Node/Bun entry: PostgreSQL + PGlite; createDatabaseAdapter()
    index.browser.ts            Browser entry: PGlite-only plugin
    base.ts                     BaseDrizzleAdapter — shared IDatabaseAdapter implementation
    types.ts                    DrizzleDatabase union type; getDb() helper
    agent-mapping.ts            Utilities for normalizing agent message examples from DB rows
    utils.ts / utils.node.ts / utils.browser.ts  Platform-specific helpers (resolvePgliteDir)
    utils/
      string-to-uuid.ts         String-to-UUID conversion utility
    connector-credential-store.ts  ConnectorCredentialStore/Vault interfaces + factory
    migration-service.ts        DatabaseMigrationService — discovers plugin schemas, runs migrations, re-applies RLS
    migrations.ts               One-off migrations (e.g., entity RLS backfill)
    rls.ts                      Row Level Security helpers (install/apply/uninstall)
    pg/
      adapter.ts                PgDatabaseAdapter (wraps BaseDrizzleAdapter for Postgres)
      manager.ts                PostgresConnectionManager — pg Pool singleton, withEntityContext
      sslmode.ts                SSL mode resolver
    pglite/
      adapter.ts                PgliteDatabaseAdapter (wraps BaseDrizzleAdapter for PGlite)
      manager.ts                PGliteClientManager — PGlite singleton, lifecycle
      errors.ts                 PGlite-specific error types
    neon/
      adapter.ts                NeonDatabaseAdapter — serverless adapter using @neondatabase/serverless
      manager.ts                NeonConnectionManager — WebSocket-based connection for Neon/Vercel/Cloudflare
    schema/
      index.ts                  Re-exports all table definitions
      agent.ts / room.ts / memory.ts / entity.ts / ...  One file per table
    services/
      advanced-memory-storage.ts  AdvancedMemoryStorageService implementation
    stores/
      agent.store.ts / memory.store.ts / room.store.ts / ...  Query logic split by domain
    runtime-migrator/
      index.ts                  RuntimeMigrator entry
      runtime-migrator.ts       Diff-based migration engine
      schema-transformer.ts     Drizzle schema → SQL diff
      extension-manager.ts      PGlite extension loading
    write-back/
      index.ts                  WriteBackService — forwards local PGlite writes to cloud API (Electric Pattern 1)
    drizzle/                    Drizzle ORM re-exports
```

## Commands

All scripts run from the plugin root via `bun run --cwd plugins/plugin-sql <script>`.

```bash
bun run --cwd plugins/plugin-sql build          # Build (cd src && bun run build.ts)
bun run --cwd plugins/plugin-sql dev            # Watch build (bun --hot build.ts)
bun run --cwd plugins/plugin-sql test           # vitest run
bun run --cwd plugins/plugin-sql typecheck      # tsc --noEmit
bun run --cwd plugins/plugin-sql lint           # biome lint
bun run --cwd plugins/plugin-sql lint:check     # biome lint (no write)
bun run --cwd plugins/plugin-sql format         # biome format (write)
bun run --cwd plugins/plugin-sql format:check   # biome format (check only)
bun run --cwd plugins/plugin-sql clean          # rm -rf src/dist .turbo
bun run --cwd plugins/plugin-sql test:e2e       # live smoke test (needs running stack)
```

## Config / env vars

| Variable | Required | Default | Effect |
|----------|----------|---------|--------|
| `POSTGRES_URL` | No | — | PostgreSQL connection string. When absent, PGlite is used. |
| `DATABASE_URL` | No | — | Alternative connection string used by the Neon serverless adapter. |
| `PGLITE_DATA_DIR` | No | `.eliza/.elizadb` | Directory (or `idb://` URL) for PGlite data storage. |
| `ENABLE_DATA_ISOLATION` | No | `false` | When `true`, enables PostgreSQL Row Level Security per-server isolation. |
| `ELIZA_SERVER_ID` | Conditional | — | Required when `ENABLE_DATA_ISOLATION=true`; becomes the RLS server UUID. |
| `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS` | No | `false` | Allow column drops and other destructive schema changes at startup. |
| `ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS` | No | auto | Controls automatic install of the `message_search_document` generated column and message-search GIN indexes. Production Postgres adapters skip this DDL by default; set `true` after scheduling the generated-column/index migration. |
| `ELIZA_ELECTRIC_SYNC_URL` | No | — | URL for the Electric sync service; enables PGlite cloud sync read path. |
| `ELIZA_CLOUD_WRITE_BASE_URL` | No | — | Base URL of the cloud API for WriteBackService (e.g. `https://api.elizacloud.ai`). If unset, write-back is a no-op. |
| `ELIZA_CLOUD_SERVICE_KEY` | No | — | `X-Service-Key` header value sent by WriteBackService to the cloud API. |
| `ELIZA_PGLITE_DISABLE_EXTENSIONS` | No | `false` | Disables PGlite extension loading when set. |
| `ELIZA_IOS_LOCAL_BACKEND` | No | — | Overrides the local backend URL for iOS platform targets. |
| `ELIZA_ANDROID_LOCAL_BACKEND` | No | — | Overrides the local backend URL for Android platform targets. |
| `NODE_ENV` | No | `development` | `production` disables verbose migration logging and tightens safety checks. |

Settings are read via `runtime.getSetting(key)` inside `plugin.init`.

## How to extend

### Add a new schema table

1. Create `src/schema/<tableName>.ts` exporting a Drizzle `pgTable(...)`.
2. Add the export to `src/schema/index.ts`.
3. The plugin's `schema` export is picked up by `DatabaseMigrationService` at startup — no manual `drizzle-kit generate` step needed in normal development.

### Add a new store (domain queries)

1. Create `src/stores/<domain>.store.ts` implementing your query functions against `DrizzleDatabase`.
2. Export from `src/stores/index.ts`.
3. Call from `BaseDrizzleAdapter` in `src/base.ts` or from the relevant `PgDatabaseAdapter` / `PgliteDatabaseAdapter`.

### Add a new service

1. Implement `Service` from `@elizaos/core` in `src/services/<name>.ts`.
2. Add it to the `services` array in the `plugin` object in `src/index.ts` (and mirror in `src/index.node.ts` / `src/index.browser.ts` as appropriate).

## Conventions / gotchas

- **Global singleton managers.** Both `PostgresConnectionManager` and `PGliteClientManager` are stored under `Symbol.for("elizaos.plugin-sql.global-singletons")` on `globalThis`. This prevents multiple pools when the module is imported from multiple paths in the same process. Do not create manager instances directly — always go through `createDatabaseAdapter()`.
- **Skips init if adapter already registered.** If another plugin already called `registerDatabaseAdapter` before this plugin's `init` runs, the plugin does nothing. This is intentional; use it to swap in a custom adapter by loading it first.
- **Dual-runtime exports.** The `exports` field in `package.json` conditionally resolves `index.node.js` (Bun/Node) vs `index.browser.js` (browser). The node entry has PostgreSQL support; the browser entry is PGlite-only. Do not import the node adapter directly in browser-targeted code.
- **Schema subpath export.** Consumers that only need schema types (e.g., for drizzle queries outside the plugin) can import from `@elizaos/plugin-sql/schema` without pulling in adapters.
- **Drizzle subpath export.** Common Drizzle query helpers (`eq`, `sql`, `and`, etc.) are re-exported from `@elizaos/plugin-sql` and `@elizaos/plugin-sql/drizzle` to avoid direct drizzle-orm version coupling in consumer code.
- **Vector dimensions are fixed per agent.** Once an agent is initialized with a specific embedding dimension (default 384), it cannot be changed. Changing it requires a new agent or manual DB surgery.
- **RLS is PostgreSQL-only.** PGlite does not support Row Level Security. The `ENABLE_DATA_ISOLATION` path is silently skipped on PGlite.
- **Tests live under `src/__tests__/`** and run via vitest configured in `src/vitest.config.ts`.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — storage / memory:**
- The actual rows / embeddings / documents written **and read back**, with their shape inspected — not a mock asserting itself.
- Query correctness: precision/recall on real data, ordering, pagination, and migration up/down.
- GC/retention, concurrency, and large-payload paths.
- A trajectory showing memory/knowledge actually recalled into a turn, where relevant.
<!-- END: evidence-and-e2e-mandate -->
