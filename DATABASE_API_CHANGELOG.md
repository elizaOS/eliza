# Database API Changelog

## Batch-First Database API Cleanup

### Summary

Comprehensive refactoring of the `IDatabaseAdapter` interface and all adapter implementations
to establish a consistent, batch-first CRUD API with proper naming conventions and return types.

### WHY This Was Done

The original adapter interface grew organically, resulting in:
- Inconsistent naming (`addRoomParticipants` vs `createRooms`)
- Mixed return types (`boolean` vs `UUID[]` for create operations)
- No batch support for many operations (single-item methods on the adapter)
- ORM types leaking into core (plugins importing Drizzle directly)

The cleanup establishes clear rules that make the API predictable for contributors.

---

### Phase 1: Interface Standardization

#### 1A. Batch-First CRUD Methods
- Added batch versions of all single-item CRUD methods
- All `create*` methods now return `Promise<UUID[]>` (the IDs that were created)
- All `update*` and `delete*` methods now return `Promise<void>` (throw on failure)
- Single-item methods remain on `AgentRuntime` as convenience wrappers

**WHY UUID[] return:** Callers often need the created IDs for subsequent operations
(e.g., create entity, then add it as participant to a room). Returning `boolean` forced
callers to pass IDs through or re-query, which was wasteful.

**WHY void for update/delete:** These operations either succeed or fail. There's no
meaningful partial success. If 3 of 5 updates fail, the caller needs to know which
ones failed (via the thrown error), not just that "some failed" (via `false`).

#### 1B. Naming Convention
- Renamed `addRoomParticipants` → `createRoomParticipants`
- Renamed `setParticipantUserState` → `updateParticipantUserState`

**WHY:** CRUD naming convention: `create` = INSERT, `get` = SELECT, `update` = UPDATE,
`delete` = DELETE. Using `add` and `set` broke this pattern and made the API harder to
predict.

#### 1C. Changed Return Types

| Method | Before | After | WHY |
|--------|--------|-------|-----|
| `createAgents` | `boolean` | `UUID[]` | Need created agent IDs |
| `createEntities` | `boolean` | `UUID[]` | Need created entity IDs |
| `createComponents` | `boolean` | `UUID[]` | Need created component IDs |
| `createRelationships` | `boolean` | `UUID[]` | Need created relationship IDs |
| `createRoomParticipants` | `boolean` | `UUID[]` | Need participant record IDs |
| `updateMemories` | `boolean[]` | `void` | Throw on failure instead |
| `ensureEmbeddingDimension` | (implicit) | `Promise<void>` | Explicit async |

---

### Phase 2: Upsert Methods & SQL Optimizations

#### 2A. Upsert Methods
Added atomic upsert methods to eliminate get-check-create race conditions:
- `upsertAgents(agents)` → `Promise<void>`
- `upsertEntities(entities)` → `Promise<void>`
- `upsertRooms(rooms)` → `Promise<void>`
- `upsertWorlds(worlds)` → `Promise<void>`

**WHY void return:** Upserts are idempotent. The caller already has the IDs (they're
the conflict key). Returning `UUID[]` suggests new IDs were generated.

**WHY on the adapter:** PostgreSQL (`ON CONFLICT DO UPDATE`), MySQL (`ON DUPLICATE KEY
UPDATE`), and PGLite all support atomic upserts in a single statement. Moving this to
the adapter avoids the runtime's get-then-create pattern which has a race window.

#### 2B. Query Pagination
Added `limit`/`offset` parameters to query methods:
- `getTasks(params)` - added `limit`, `offset`
- `getRelationships(params)` - added `limit`, `offset`
- `getRoomsByWorld(worldId)` - added `limit`, `offset`

**WHY:** Without limits, a query for "all tasks in room X" could return thousands of
records, causing memory exhaustion and UI freezes.

#### 2C. MySQL Optimizations
- Aligned MySQL adapter with PostgreSQL optimizations
- Verified proper index coverage for all query patterns
- Used `ON DUPLICATE KEY UPDATE` for upserts

#### 2D. Index Audit
Verified all query patterns have proper index coverage across PostgreSQL and MySQL schemas.

---

### Phase 3: Interface Segregation & Plugin Support

#### 3A. IMessagingAdapter Extraction
Extracted messaging-specific operations into a separate `IMessagingAdapter` interface:
- `createMessageServer`, `getMessageServers`, `getMessageServerById`
- `createChannel`, `getChannels`, `getChannelById`
- `createMessage`, `getMessages`, `getMessageById`

**WHY:** Not all adapters support messaging tables. In-memory and local adapters don't
need message servers, channels, or messages. Putting these on `IDatabaseAdapter` would
force every adapter to implement stubs.

Added `runtime.getMessagingAdapter()` which returns `IMessagingAdapter | null` via
duck-typing (checks if the adapter has messaging methods).

#### 3B. Plugin Schema Registration
Added `registerPluginSchema` and `getPluginStore` to `IDatabaseAdapter` (optional):

- `PluginSchema` - adapter-agnostic table definition format
- `IPluginStore` - generic CRUD interface for plugin data
- `SqlPluginStore` - SQL implementation with dialect detection (PG + MySQL)

**WHY:** Plugins like goals and todos need custom tables. Without this, they must
cast `runtime.db` to Drizzle types, creating tight coupling to SQL adapters and
preventing plugins from working with in-memory backends.

---

### Adapter Updates

All four adapter implementations updated to match the new interface:

| Adapter | Package | Status |
|---------|---------|--------|
| PostgreSQL | `plugin-sql` | ✅ Updated |
| PGLite | `plugin-sql` | ✅ Updated |
| MySQL | `plugin-sql` | ✅ Updated |
| In-Memory | `plugin-inmemorydb` | ✅ Updated |
| Local Storage | `plugin-localdb` | ✅ Updated |

### Removed Package

| Package | Reason |
|---------|--------|
| `plugin-mysql` | Redundant. `plugin-sql` already handles MySQL via `MYSQL_URL` detection. The standalone package had diverged from the shared interface. |

---

### Files Changed

**Core types** (`packages/typescript/src/types/`):
- `database.ts` - Updated `IDatabaseAdapter` with batch-first methods, upserts, pagination
- `messaging.ts` - Added `IMessagingAdapter`, `MessageServer`, `MessagingChannel`, `MessagingMessage`
- `plugin-store.ts` - Added `PluginSchema`, `IPluginStore`, filter types
- `runtime.ts` - Added `getMessagingAdapter()` to `IAgentRuntime`
- `index.ts` - Re-exports for new type files

**Runtime** (`packages/typescript/src/`):
- `runtime.ts` - Implemented `getMessagingAdapter()`, updated all adapter calls

**SQL adapter** (`plugins/plugin-sql/typescript/`):
- `base.ts` - PG/PGLite adapter updated with new return types, messaging types, plugin store
- `mysql/base.ts` - MySQL adapter updated identically
- `stores/plugin.store.ts` - New: `SqlPluginStore` with PG+MySQL dialect detection
- `stores/*.store.ts` - Updated return types for all store functions
- `mysql/stores/*.store.ts` - Updated return types for all MySQL store functions

**In-memory adapter** (`plugins/plugin-inmemorydb/typescript/`):
- `adapter.ts` - Updated method names and return types

**Local adapter** (`plugins/plugin-localdb/typescript/`):
- `adapter.ts` - Updated method names and return types

**Tests** (`packages/typescript/src/__tests__/`):
- Updated mock adapters in all test files to use new method names and return types
