# Database Adapter Audit: Incomplete Implementations

**Date:** 2025-03-17  
**Scope:** All DB adapters (TypeScript, Python, Rust) implementing or extending `IDatabaseAdapter` / `DatabaseAdapter`.

---

## Summary

| Adapter | Location | Severity | Issue |
|--------|----------|----------|--------|
| ~~**LocalDatabaseAdapter**~~ | plugin-localdb | ~~**High**~~ **Fixed** | ~~`patchComponent` is a no-op~~ Implemented: in-memory patch (set/push/remove/increment), throws when component not found or invalid path/op |
| ~~**Pg / Pglite / MySQL2**~~ | plugin-sql | ~~Medium~~ **Resolved** | ~~`getMemoriesByServerId`~~ Removed. Use **`getMemoriesByWorldIds({ worldIds, tableName?, limit? })`** (one or more server/world IDs). |
| ~~**Plugin store (PG + MySQL)**~~ | plugin-sql | ~~Medium~~ **Resolved** | ~~`migratePluginTable` TODO~~ Schema diffing implemented: ADD COLUMN / CREATE INDEX for missing columns/indexes |
| ~~plugin-inmemorydb / plugin-localdb~~ | — | ~~Low (doc only)~~ **Resolved** | ~~Optional plugin store~~ **Implemented:** both adapters now implement `registerPluginSchema` and `getPluginStore` (in-memory/store-backed) |
| plugin-inmemorydb / plugin-localdb | — | Low (by design) | `cleanupAgents` no-op; documented as intentional |

---

## 1. ~~High: LocalDB `patchComponent` is a no-op~~ **Fixed**

**File:** `plugins/plugin-localdb/typescript/adapter.ts`  
**Method:** `patchComponent(componentId, ops, options)`

**Resolution:** Implemented in-memory patch logic (set, push, remove, increment); throws when component not found or invalid path/op. Original issue (no-op) is resolved.

**Contract (IDatabaseAdapter / DatabaseAdapter):**
- Apply JSON Patch operations to the component’s `data` field.
- **Throw** if component is not found.
- **Throw** on invalid path or incompatible operation (e.g. push on non-array, increment on non-number).

**Impact:** Callers that rely on `patchComponent` (e.g. partial component updates) will see no updates and no error. This violates the documented contract and can cause silent data bugs.

**Recommendation:**
- **Option A:** Implement in-memory patch logic (e.g. load component, apply RFC 6902-style ops in JS, then persist). This matches core’s `InMemoryDatabaseAdapter` and plugin-inmemorydb behavior.
- **Option B:** If patch is not supported by design, **throw** a clear error (e.g. `"patchComponent is not supported by LocalDB adapter"`) so callers can fall back or fail fast instead of silently doing nothing.

---

## 2. ~~Medium: SQL adapters — `getMemoriesByServerId`~~ **Resolved: method removed**

**Files:**
- `plugins/plugin-sql/typescript/pg/adapter.ts`
- `plugins/plugin-sql/typescript/pglite/adapter.ts`
- `plugins/plugin-sql/typescript/mysql/mysql2/adapter.ts`

**Method:** `getMemoriesByServerId(params: { serverId: UUID; count?: number }): Promise<Memory[]>`

**Current behavior:** Logs a warning *"getMemoriesByServerId called but not implemented"* and returns `[]`.

**Note:** This method is **not** part of the core `IDatabaseAdapter` in `packages/typescript/src/types/database.ts`. It is an **extension** on the SQL adapters (likely for multi-server or server-scoped memory queries). The core runtime does not depend on it; only plugin-secrets-manager tests reference it (as a mock).

**Impact:** Any code that calls this extension will get an empty list and a log line, not real data. If no production code calls it, impact is limited but the API is misleading.

**Resolution:** Removed from pg, pglite, mysql2 adapters and plugin-secrets-manager mock. Use **`getMemoriesByWorldIds({ worldIds, tableName?, limit? })`** only (single world = `worldIds: [worldId]`). Implemented on `IDatabaseAdapter` and all adapters.

---

## 3. ~~Medium: Plugin schema migration~~ **Resolved: schema diffing implemented**

**Files:**
- `plugins/plugin-sql/typescript/stores/plugin.store.ts` (Postgres / shared)
- `plugins/plugin-sql/typescript/mysql/stores/plugin.store.ts` (MySQL)

**Function:** `migratePluginTable(db, pluginName, table)` (and dialect-specific variants)

**Resolution:** Schema diffing is implemented. When a table already exists, the store queries existing columns and indexes from information_schema / pg_indexes (PG) or INFORMATION_SCHEMA (MySQL), adds missing columns via ALTER TABLE ADD COLUMN, and creates missing indexes. Additive only; idempotent.

---

## 4. Low: Optional interface members (documented) — Addressed

**Adapters:** plugin-inmemorydb, plugin-localdb

**Members:** `registerPluginSchema`, `getPluginStore` (and optionally `runPluginMigrations` in interface; abstract class requires it).

**What getPluginStore is:** Plugins that need custom tables (e.g. goals, todos) call `runtime.getPluginStore(pluginName)` to get a namespaced CRUD store (`IPluginStore`) instead of using Drizzle directly.

**Status:** **Implemented.** Both plugin-inmemorydb and plugin-localdb now implement `registerPluginSchema` and `getPluginStore`. Core added `InMemoryPluginStore` and `createMapBackend()` in `database/inMemoryPluginStore.ts`; core `InMemoryDatabaseAdapter` uses them. plugin-inmemorydb uses the map backend (in-memory); plugin-localdb uses a storage-backed backend so plugin data is persisted via IStorage (collection prefix `plugin_store_`). **runPluginMigrations** remains a no-op for both. **cleanupAgents** remains a no-op by design.

**cleanupAgents:** Both adapters implement `cleanupAgents()` as a no-op with a comment that in-memory/file-backed adapters do not perform time-based cleanup. This is consistent with the interface’s “IMPLEMENTATION NOTE” that InMemory adapters may do nothing. No change required.

---

## 5. Adapters reviewed with no incomplete implementations

- **packages/typescript** `InMemoryDatabaseAdapter`: Full contract including `patchComponent`, `registerPluginSchema`, `getPluginStore`; `runPluginMigrations` / `runMigrations` are no-ops by design (documented).
- **plugins/plugin-inmemorydb** `InMemoryDatabaseAdapter`: Full batch CRUD, patch, and plugin store (in-memory); only messaging adapter is omitted (documented).
- **plugins/plugin-localdb** `LocalDatabaseAdapter`: Full batch CRUD, `patchComponent`, and plugin store (persisted via IStorage); only messaging adapter is omitted (documented).
- **plugins/plugin-sql** base (Postgres/PGLite/MySQL): Batch CRUD, transactions, components, memories, plugin store, and plugin table schema diffing (see §3) are implemented.
- **plugins/plugin-sql Python** adapters: No `NotImplementedError` or stub adapter methods found; the `pass` usages are in base class definitions and exception handlers, not in adapter API methods.
- **plugins/plugin-sql Rust**: No `unimplemented!` or `todo!` in adapter code paths.

---

## Reference: Contract sources

- **TypeScript:** `packages/typescript/src/types/database.ts` (`IDatabaseAdapter`), `packages/typescript/src/database.ts` (`DatabaseAdapter` abstract class).
- **Batch-first:** Create methods return `UUID[]`; update/delete return `void` and throw on failure. Query methods (e.g. `getMemories`, `getComponent`) return single or array results per signature.

---

## Suggested next steps

1. ~~**High:** Fix or explicitly reject `patchComponent` in LocalDB.~~ **Done:** Implemented in-memory patch (set/push/remove/increment); throws when component not found or invalid path/op.
2. ~~**Medium:** Either implement or remove/document `getMemoriesByServerId` on SQL adapters.~~ **Done:** Removed; use `getMemoriesByWorldIds` (world = server).
3. ~~**Medium:** Implement plugin table schema diffing/migration in plugin-sql.~~ **Done:** Additive schema diffing (ADD COLUMN / CREATE INDEX) implemented for PG and MySQL.

**All audit items have been addressed.** Remaining note: `cleanupAgents` is a no-op on in-memory/file-backed adapters by design (documented).
