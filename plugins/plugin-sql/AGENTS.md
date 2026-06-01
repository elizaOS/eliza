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
    index.ts                    Generic/default entry (re-exports from both node + browser)
    index.node.ts               Node/Bun entry: PostgreSQL + PGlite; createDatabaseAdapter()
    index.browser.ts            Browser entry: PGlite-only plugin
    base.ts                     BaseDrizzleAdapter — shared IDatabaseAdapter implementation
    types.ts                    DrizzleDatabase union type; getDb() helper
    utils.ts / utils.node.ts / utils.browser.ts  Platform-specific helpers (resolvePgliteDir)
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
| `PGLITE_DATA_DIR` | No | `./pglite` | Directory (or `idb://` URL) for PGlite data storage. |
| `ENABLE_DATA_ISOLATION` | No | `false` | When `true`, enables PostgreSQL Row Level Security per-server isolation. |
| `ELIZA_SERVER_ID` | Conditional | — | Required when `ENABLE_DATA_ISOLATION=true`; becomes the RLS server UUID. |
| `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS` | No | `false` | Allow column drops and other destructive schema changes at startup. |
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
