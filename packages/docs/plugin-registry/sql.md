---
title: "SQL Plugin"
sidebarTitle: "SQL"
description: "Database layer — SQLite adapter, schema, migrations, query interface, and memory persistence."
---

<Warning>
SQL/database support is a built-in runtime capability, not a standalone installable plugin. The runtime handles database connections automatically.
</Warning>

The SQL plugin is the database layer for Eliza agents. It provides persistent storage for conversation memory, entity data, knowledge embeddings, and agent state.

> **Core plugin.** This is a foundational runtime plugin that is always loaded. It is not listed in the bundled `plugins.json` index because it is not user-installable — it ships as part of the elizaOS core.

**Package:** `@elizaos/plugin-sql` (core plugin — always loaded)

## Overview

The SQL plugin implements the `IDatabaseAdapter` interface from elizaOS core. Eliza defaults to **PGLite** (embedded PostgreSQL) for local state, with optional external PostgreSQL for production. It is the first core plugin loaded because all other plugins depend on persistent storage.

## Database Location

The default PGLite database is stored at:

```
~/.eliza/workspace/.eliza/.elizadb
```

Override via config:

```json5
{
  database: {
    provider: "pglite",
    pglite: {
      dataDir: "~/.eliza/workspace/.eliza/.elizadb",
    },
  },
}
```

## Schema

The SQL plugin manages the following tables:

| Table | Description |
|-------|-------------|
| `agents` | Agent configuration and character data |
| `entities` | Users, bots, and other entities the agent knows |
| `rooms` | Channels, conversations, and DMs |
| `participants` | Entity–room membership |
| `memories` | Message history and knowledge fragments |
| `components` | Entity component data (custom structured state) |
| `worlds` | Connected platforms and servers |
| `tasks` | Background task queue |
| `relationships` | Entity relationship graph |

## Memory Storage

Memories are stored with:

- `content` — The memory text and metadata
- `embedding` — Vector embedding (384 dimensions by default — Eliza caps `EMBEDDING_DIMENSION` to 384)
- `type` — `message`, `knowledge`, `reflection`, `fact`, etc.
- `roomId` — The room this memory belongs to
- `entityId` — The entity (user/agent) associated with the memory
- `agentId` — The agent that owns this memory

## Vector Search

The SQL plugin supports cosine similarity search over embeddings for the RAG pipeline:

```typescript
const results = await runtime.searchMemories({
  tableName: "memories",
  query: embeddingVector,
  topK: 10,
  minScore: 0.7,
  roomId: currentRoomId,
});
```

SQLite does not have a native vector extension, so similarity search is performed in-process using JavaScript. For large knowledge bases (>100k documents), consider a PostgreSQL backend.

## PostgreSQL Support

For production deployments, the SQL plugin supports external PostgreSQL:

```json5
{
  database: {
    provider: "postgres",
    postgres: {
      connectionString: "postgresql://user:password@host:5432/eliza",
      ssl: true,
    },
  },
}
```

PostgreSQL deployments use `pgvector` for efficient similarity search.

## Migrations

The SQL plugin runs migrations automatically on startup. Migration files are embedded in the plugin package and versioned sequentially. **There are no user-managed migration files** — schema changes are shipped with new plugin versions and applied transparently.

This means:
- No `migrate` or `db:push` step is required before or after upgrades.
- Schema compatibility is guaranteed by the plugin version pinned in `package.json`.
- The `bun run db:check` command validates database API security and query-guard boundaries (30 unit tests) and database API endpoint behavior (40 e2e tests). It does not validate schema state — migrations are automatic.

To inspect the current schema version:

```bash
eliza doctor
```

## Runtime API

Other plugins access the database through the runtime's adapter methods:

```typescript
// Store a memory
await runtime.createMemory({
  id: uuid(),
  entityId: message.entityId,
  roomId: message.roomId,
  content: { text: "User prefers dark mode" },
  type: "fact",
});

// Retrieve memories
const memories = await runtime.getMemories({
  roomId: message.roomId,
  count: 20,
  unique: true,
});

// Store entity data
await runtime.createEntity({
  id: userId,
  name: "Alice",
  type: "user",
  metadata: { platform: "telegram" },
});

// Get entity
const entity = await runtime.getEntityById(userId);

// Update component
await runtime.setComponent(userId, "userPreferences", {
  theme: "dark",
  language: "en",
});
```

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `database.type` | `sqlite` or `postgres` | `sqlite` |
| `database.url` | PostgreSQL connection URL | — |
| `database.path` | Custom SQLite file path | Auto-resolved |
| `database.vectorDimensions` | Embedding vector size | `384` (Eliza caps `EMBEDDING_DIMENSION` to 384) |

## Related

- [Knowledge Plugin](/plugin-registry/documents) — Uses SQL for embedding storage
- [Secrets (runtime)](/runtime/services#secrets-secrets-service) — Persists secrets via SQL
- [Cron Plugin](/plugin-registry/cron) — Core message processing
