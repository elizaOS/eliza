# elizaOS Database API

## Overview

The elizaOS database abstraction layer (`IDatabaseAdapter`) provides a unified interface for interacting with database backends. All adapter implementations share the same contract, ensuring plugins and runtime code work identically regardless of which database is behind the scenes.

### Supported Backends

| Backend | Package | When Used |
|---------|---------|-----------|
| **MySQL** | `plugin-sql` | `MYSQL_URL` is set |
| **PostgreSQL** | `plugin-sql` | `POSTGRES_URL` is set (no MySQL) |
| **PGLite** | `plugin-sql` | Neither MySQL nor PostgreSQL configured (default) |
| **In-Memory** | `plugin-inmemorydb` | Explicit opt-in for tests or ephemeral agents |
| **Local Storage** | `plugin-localdb` | Browser or file-based local persistence |

`plugin-sql` detects the backend automatically:
1. Checks `MYSQL_URL` first
2. Then `POSTGRES_URL`
3. Falls back to PGLite with `PGLITE_DATA_DIR` or default directory

### Why This Architecture

- **ORM stays in the adapter.** The runtime and plugins never import Drizzle (or any ORM). They call `IDatabaseAdapter` methods. This means a future adapter could use Prisma, Kysely, or raw SQL without touching any plugin code.
- **Batch-first.** Every mutation method accepts and returns arrays. Single-item operations are convenience wrappers on `AgentRuntime`, not on the adapter. This lets SQL adapters use multi-row INSERT/UPDATE statements instead of N+1 queries.
- **Failures throw, not return booleans.** Create methods return `UUID[]` (the IDs that were created). Update and delete methods return `void`. If something fails, they throw. Callers don't need `if (!result) { handle error }` everywhere.

---

## Design Principles

### 1. Batch-First CRUD

All mutation methods operate on arrays. The adapter is the "low-level batch layer"; the runtime provides single-item convenience methods.

**WHY:** SQL databases are optimized for set operations. A single `INSERT INTO ... VALUES (...), (...), (...)` is dramatically faster than three separate INSERT statements due to reduced round-trips, transaction overhead, and WAL writes. Even in-memory adapters benefit from batch interfaces because it keeps the API surface consistent.

```typescript
// Adapter (batch) - what IDatabaseAdapter exposes
createAgents(agents: Partial<Agent>[]): Promise<UUID[]>
createEntities(entities: Entity[]): Promise<UUID[]>
createMemories(memories: Array<{memory, tableName, unique?}>): Promise<UUID[]>

// Runtime (single-item convenience) - what plugins typically call
runtime.createAgent(agent): Promise<UUID>
runtime.createEntity(entity): Promise<UUID>
runtime.createMemory(memory, tableName, unique?): Promise<UUID>
```

### 2. CRUD Naming Convention

| Prefix | Operation | Returns |
|--------|-----------|---------|
| `create*` | INSERT | `UUID[]` (created IDs) |
| `get*` / `search*` | SELECT | Entity arrays or `null` |
| `update*` | UPDATE | `void` (throws on failure) |
| `delete*` | DELETE | `void` (throws on failure) |
| `upsert*` | INSERT ... ON CONFLICT UPDATE | `void` (caller already has IDs) |

**WHY `upsert` returns `void`:** Upserts are idempotent by design. The caller already has the entity IDs (they're the lookup key). Returning `UUID[]` would suggest new IDs were generated, which is misleading when rows already exist.

### 3. Interface Segregation

The `IDatabaseAdapter` handles core CRUD. Messaging-specific operations live on `IMessagingAdapter`, a separate interface. The runtime provides `getMessagingAdapter()` which returns the messaging interface if the adapter supports it (duck-typed).

**WHY:** Not all adapters need messaging tables (message servers, channels, messages). In-memory and local storage adapters don't implement them. Putting messaging methods on `IDatabaseAdapter` would force every adapter to stub them out.

### 4. Plugin Schema Registration

Plugins can define custom tables without importing Drizzle:

```typescript
// Plugin defines schema in adapter-agnostic format
const schema: PluginSchema = {
  pluginName: "goals",
  tables: [{
    name: "goals",
    columns: [
      { name: "id", type: "uuid", primaryKey: true },
      { name: "title", type: "text", notNull: true },
      { name: "is_completed", type: "boolean", default: false },
    ],
    indexes: [{ name: "idx_completed", columns: ["is_completed"] }]
  }]
};

// Register schema (adapter creates tables)
await adapter.registerPluginSchema(schema);

// Get a store for CRUD operations
const store = adapter.getPluginStore("goals");
const incomplete = await store.query("goals", { is_completed: false });
```

**WHY:** Without this, plugins must cast `runtime.db` to Drizzle types, which only works with SQL adapters and creates tight coupling. The `PluginSchema` / `IPluginStore` layer lets plugins define data needs declaratively, and each adapter decides how to implement it.

---

## Method Reference

### Connection & Lifecycle

| Method | Returns | Description |
|--------|---------|-------------|
| `initialize(config?)` | `void` | Open connection, run bootstrap |
| `isReady()` | `boolean` | Health check |
| `close()` | `void` | Graceful shutdown |
| `getConnection()` | `DB` | Raw connection (for advanced use) |
| `withEntityContext?(entityId, callback)` | `T` | Execute within RLS context |

### Agent CRUD

| Method | Returns | Description |
|--------|---------|-------------|
| `getAgents()` | `Agent[]` | All agents |
| `getAgentsByIds(ids)` | `Agent[]` | By ID list |
| `createAgents(agents)` | `UUID[]` | Insert agents |
| `updateAgents(updates)` | `void` | Modify agents |
| `deleteAgents(ids)` | `void` | Remove agents |
| `upsertAgents(agents)` | `void` | Insert or update |
| `countAgents()` | `number` | Total count |
| `cleanupAgents()` | `void` | Remove stale agents |

### Entity & Component CRUD

| Method | Returns | Description |
|--------|---------|-------------|
| `getEntitiesForRoom(roomId)` | `Entity[]` | Entities in room |
| `createEntities(entities)` | `UUID[]` | Insert entities |
| `upsertEntities(entities)` | `void` | Insert or update |
| `getEntitiesByIds(ids)` | `Entity[]` | By ID list |
| `updateEntities(entities)` | `void` | Modify entities |
| `deleteEntities(ids)` | `void` | Remove entities |
| `createComponents(components)` | `UUID[]` | Insert components |
| `getComponentsByIds(ids)` | `Component[]` | By ID list |
| `updateComponents(components)` | `void` | Modify components |
| `deleteComponents(ids)` | `void` | Remove components |

### Memory CRUD

| Method | Returns | Description |
|--------|---------|-------------|
| `getMemories(params)` | `Memory[]` | Query with filters |
| `getMemoriesByIds(ids)` | `Memory[]` | By ID list |
| `createMemories(memories)` | `UUID[]` | Insert memories |
| `updateMemories(memories)` | `void` | Modify memories |
| `deleteMemories(ids)` | `void` | Remove memories |
| `searchMemories(params)` | `Memory[]` | Vector similarity search |
| `countMemories(roomId)` | `number` | Count in room |

### Room & Participant CRUD

| Method | Returns | Description |
|--------|---------|-------------|
| `getRoomsByIds(ids)` | `Room[]` | By ID list |
| `createRooms(rooms)` | `UUID[]` | Insert rooms |
| `updateRooms(rooms)` | `void` | Modify rooms |
| `deleteRooms(ids)` | `void` | Remove rooms |
| `upsertRooms(rooms)` | `void` | Insert or update |
| `createRoomParticipants(entityIds, roomId)` | `UUID[]` | Add entities to room |
| `deleteParticipants(participants)` | `void` | Remove from room |
| `updateParticipants(participants)` | `void` | Modify participants |
| `updateParticipantUserState(roomId, entityId, state)` | `void` | Set FOLLOWED/MUTED/null |

### Relationship CRUD

| Method | Returns | Description |
|--------|---------|-------------|
| `getRelationship(params)` | `Relationship?` | By source+target |
| `getRelationships(params)` | `Relationship[]` | By entity+tags |
| `createRelationships(relationships)` | `UUID[]` | Insert relationships |
| `getRelationshipsByIds(ids)` | `Relationship[]` | By ID list |
| `updateRelationships(relationships)` | `void` | Modify relationships |
| `deleteRelationships(ids)` | `void` | Remove relationships |

### Task, Log, Cache, World, Pairing

All follow the same batch-first pattern: `create*` returns `UUID[]`, `update*`/`delete*` returns `void`, `get*` returns entity arrays.

### Plugin Schema (Optional)

| Method | Returns | Description |
|--------|---------|-------------|
| `registerPluginSchema?(schema)` | `void` | Create/migrate plugin tables |
| `getPluginStore?(pluginName)` | `IPluginStore?` | Get CRUD interface for plugin tables |

---

## Migration Guide

### Renamed Methods

| Old Name | New Name | WHY |
|----------|----------|-----|
| `addRoomParticipants` | `createRoomParticipants` | CRUD consistency: 'create' = insert |
| `setParticipantUserState` | `updateParticipantUserState` | CRUD consistency: 'update' = modify |

### Changed Return Types

| Method | Old Return | New Return | WHY |
|--------|-----------|------------|-----|
| `createAgents` | `boolean` | `UUID[]` | Callers need created IDs |
| `createEntities` | `boolean` | `UUID[]` | Callers need created IDs |
| `createComponents` | `boolean` | `UUID[]` | Callers need created IDs |
| `createRelationships` | `boolean` | `UUID[]` | Callers need created IDs |
| `createRoomParticipants` | `boolean` | `UUID[]` | Callers need created IDs |
| `updateMemories` | `boolean[]` | `void` | Throw on failure instead |
| `ensureEmbeddingDimension` | `void` (implicit) | `Promise<void>` (explicit) | Was missing async marker |

### Removed Package

| Package | Replacement | WHY |
|---------|-------------|-----|
| `plugin-mysql` | `plugin-sql` (MySQL mode) | `plugin-sql` already handles MySQL via `MYSQL_URL` detection. Separate package was redundant and diverged. |

---

## Implementing a Custom Adapter

To implement a new database adapter:

1. Extend `DatabaseAdapter<YourConnectionType>`
2. Implement all non-optional methods on `IDatabaseAdapter`
3. Return `UUID[]` from all `create*` methods
4. Throw errors from `update*`/`delete*` methods instead of returning booleans
5. Optionally implement `registerPluginSchema` and `getPluginStore` for plugin table support
6. Optionally implement `IMessagingAdapter` methods for messaging support

```typescript
class MyAdapter extends DatabaseAdapter<MyConnection> {
  async createAgents(agents: Partial<Agent>[]): Promise<UUID[]> {
    // Insert all agents, return their IDs
    // Throw on failure (don't return false)
  }
  
  async updateMemories(memories: Array<...>): Promise<void> {
    // Update all memories
    // Throw if any fail (don't return boolean[])
  }
}
```
