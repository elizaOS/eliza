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

## Environment Variables

| Variable | Required | Default | Effect |
|----------|----------|---------|--------|
| `POSTGRES_URL` | No | — | PostgreSQL connection string. When absent, PGlite is used. |
| `PGLITE_DATA_DIR` | No | `.eliza/.elizadb` | Directory (or `idb://` URL) for PGlite data storage. |
| `ENABLE_DATA_ISOLATION` | No | `false` | When `true`, enables PostgreSQL Row Level Security per-server isolation. |
| `ELIZA_SERVER_ID` | Conditional | — | Required when `ENABLE_DATA_ISOLATION=true`; becomes the RLS server UUID. |
| `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS` | No | `false` | Allow column drops and other destructive schema changes at startup. |
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

## Connection Management

Both `PostgresConnectionManager` and `PGliteClientManager` are stored under `Symbol.for("elizaos.plugin-sql.global-singletons")` on `globalThis`. This prevents multiple pools when the module is imported from multiple paths in the same process. Do not construct manager instances directly — always go through `createDatabaseAdapter()`.

## Database Pool Configuration

Default pool configuration:

```typescript
{
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
}
```

## Error Handling Configuration

```typescript
{
    failureThreshold: 5,
    resetTimeout: 60000,
    halfOpenMaxAttempts: 3,
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 10000,
    jitterMax: 1000,
    connectionTimeout: 5000
}
```

## Clean Shutdown

The adapter registers handlers for `SIGINT`, `SIGTERM`, and `beforeExit` to close database connections properly.

## Requirements

- Node.js or Bun
- PostgreSQL with vector extension (for Postgres mode)
