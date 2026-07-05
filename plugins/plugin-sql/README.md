# @elizaos/plugin-sql

SQL database adapter plugin for elizaOS — provides persistent storage via PostgreSQL or embedded PGlite (WASM), with Drizzle ORM, automatic schema migrations, and optional Row Level Security.

## Installation

```bash
bun add @elizaos/plugin-sql
```

## Overview

This plugin registers a `DatabaseAdapter` with the elizaOS agent runtime so that all core runtime persistence (memories, entities, rooms, tasks, cache, logs, relationships, etc.) works against a real SQL backend. On Node/Bun it selects PostgreSQL when `POSTGRES_URL` is set, otherwise falls back to embedded PGlite. In the browser build it always uses PGlite (WASM).

## Database Schema

The plugin uses the following main tables:

- **Agent**: Agent information and configurations
- **Room / Channel**: Conversation rooms and messaging channels
- **Participant / ChannelParticipant**: Participants in rooms and channels
- **Memory**: Agent memories with vector embeddings for semantic search
- **Embedding**: Vector embeddings for entities
- **Entity**: Entities agents interact with
- **Relationship**: Relationships between entities
- **Component**: Agent components and configurations
- **Tasks**: Tasks and goals
- **Log**: System logs
- **Cache**: Frequently accessed data cache
- **World**: World settings and configurations

Table definitions live in `src/schema/`.

## Electric Sync (PGlite ↔ Electric Cloud)

When `ELIZA_ELECTRIC_SYNC_URL` and `AGENT_ID` are set, PGlite connects to an Electric sync service and streams real-time updates for all core tables. Each agent syncs only its own rows (filtered by `agent_id` / `id`), preserving per-agent isolation in shared-Neon deployments.

### Local dev with Electric Cloud

The e2e write-back test (`__tests__/integration/electric-write-back.test.ts`) uses a [Caddy](https://caddyserver.com) reverse proxy to forward shape requests to Electric Cloud with auth. Caddy is the proxy [recommended by Electric](https://electric.ax/docs/sync/guides/troubleshooting#missing-headers).

```bash
# 1. Set your Electric Cloud credentials (get these from dashboard.electric-sql.cloud)
export ELECTRIC_CLOUD_SOURCE_ID=svc-xxxxxxxxxxxx
export ELECTRIC_CLOUD_SECRET=eyJ...

# 2. Start the Caddy proxy
caddy run --config plugins/plugin-sql/caddy/electric-proxy.Caddyfile

# 3. Run the e2e test
bun run --cwd plugins/plugin-sql test -- \
  __tests__/integration/electric-write-back.test.ts
```

The Caddyfile at `plugins/plugin-sql/caddy/electric-proxy.Caddyfile` forwards every incoming request to `api.electric-sql.cloud` with auth query params appended.

## Environment Variables

| Variable | Required | Default | Effect |
|----------|----------|---------|--------|
| `POSTGRES_URL` | No | — | PostgreSQL connection string. When absent, PGlite is used. |
| `PGLITE_DATA_DIR` | No | `.eliza/.elizadb` | Directory (or `idb://` URL) for PGlite data storage. |
| `ELIZA_ELECTRIC_SYNC_URL` | No | — | Base URL of Electric sync service (e.g. `http://localhost:3001` via Caddy). |
| `AGENT_ID` | Conditional | — | UUID of the agent. Required when `ELIZA_ELECTRIC_SYNC_URL` is set (per-agent WHERE filter). |
| `ELIZA_CLOUD_WRITE_BASE_URL` | No | — | Write-back cloud endpoint for forwarding local PGlite writes to Postgres. |
| `ELIZA_CLOUD_SERVICE_KEY` | No | — | Service key for authenticating write-back requests. |
| `ELECTRIC_CLOUD_SOURCE_ID` | Test-only | — | Electric Cloud source ID (consumed by Caddy, not the runtime). |
| `ELECTRIC_CLOUD_SECRET` | Test-only | — | Electric Cloud JWT secret (consumed by Caddy, not the runtime). |
| `ELIZA_PGLITE_DISABLE_EXTENSIONS` | No | `false` | Set to `1` to disable PGlite extensions (vector, live, fuzzystrmatch, Electric sync). |
| `ENABLE_DATA_ISOLATION` | No | `false` | When `true`, enables PostgreSQL Row Level Security per-server isolation. |
| `ELIZA_SERVER_ID` | Conditional | — | Required when `ENABLE_DATA_ISOLATION=true`; becomes the RLS server UUID. |
| `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS` | No | `false` | Allow column drops and other destructive schema changes at startup. |
| `ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS` | No | auto | Controls automatic install of the `message_search_document` generated column and message-search GIN indexes. Production Postgres adapters skip this DDL by default; set `true` after scheduling the generated-column/index migration. |
| `NODE_ENV` | No | `development` | `production` disables verbose migration logging and tightens safety checks. |

Settings are read via `runtime.getSetting(key)` inside `plugin.init`.

## Vector Dimensions

```typescript
VECTOR_DIMS = {
  SMALL: 384,
  MEDIUM: 512,
  LARGE: 768,
  XL: 1024,
  XXL: 1536,
  XXXL: 3072,
};
```

Once an agent is initialized with a specific embedding dimension, it cannot be changed without a new agent or manual DB surgery.

## Runtime Migrations

Plugins export a `schema` object; `DatabaseMigrationService` diffs the schema against the live DB at startup and runs migrations automatically. No manual `drizzle-kit generate` / `drizzle-kit push` step is needed in normal development.

```typescript
// In your plugin
export const plugin = {
  name: "@your-org/plugin-name",
  schema: schema, // Drizzle schema object
  // ...
};
```

Destructive changes (column drops, type changes) are blocked by default. Set `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true` to allow them.

Message-search DDL is also guarded on production Postgres. The generated column and GIN indexes are still installed automatically for development/test and embedded PGlite. For production Postgres, schedule the table rewrite/index creation and run with `ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS=true` once the deployment window is approved.

## Connection Management

Both `PostgresConnectionManager` and `PGliteClientManager` are stored under `Symbol.for("elizaos.plugin-sql.global-singletons")` on `globalThis`. This prevents multiple pools when the module is imported from multiple paths in the same process. Do not construct manager instances directly — always go through `createDatabaseAdapter()`.

## Database Pool Configuration

Default Postgres pool configuration (`src/pg/manager.ts`):

```typescript
{
    max: 20,
    min: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000
}
```

## Retry Configuration

`BaseDrizzleAdapter` retries failed operations with exponential backoff and jitter (`src/base.ts`):

```typescript
{
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 10000,
    jitterMax: 1000
}
```

## Requirements

- Node.js or Bun
- PostgreSQL with vector extension (for Postgres mode)
