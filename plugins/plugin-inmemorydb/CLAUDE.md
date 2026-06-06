# @elizaos/plugin-inmemorydb

Pure in-memory, ephemeral `IDatabaseAdapter` for elizaOS — zero setup, zero persistence, everything gone on `close()`.

## Purpose / role

Provides a complete `DatabaseAdapter` implementation backed by JavaScript `Map` structures and an in-memory HNSW vector index. No disk I/O, no migrations, no configuration required. Load it as a plugin so the runtime registers the adapter automatically, or construct `InMemoryDatabaseAdapter` directly (useful in tests). It is opt-in — the runtime leaves the existing adapter registered if one is already present.

Supported platforms: Node.js and browser (separate build entries in `exports`). Loaded via the `init` hook in `index.ts`.

## Plugin surface

This plugin registers no actions, providers, evaluators, or routes. Its sole contribution is a `DatabaseAdapter`.

| What | Name | Where |
|------|------|--------|
| Plugin object | `plugin` / `default` | `index.ts` |
| Adapter factory | `createDatabaseAdapter(agentId)` | `index.ts` |
| Adapter class | `InMemoryDatabaseAdapter` | `adapter.ts` |
| Storage backend | `MemoryStorage` | `storage-memory.ts` |
| Vector index | `EphemeralHNSW` | `hnsw.ts` |

`init` hook behavior: checks for an existing adapter on the runtime (`r.adapter`, `r.databaseAdapter`, or `r.hasDatabaseAdapter()`); if one is already registered it exits silently. Otherwise it constructs a `MemoryStorage` singleton (keyed by `Symbol.for("elizaos.plugin-inmemorydb.global-singletons")`) and registers a new `InMemoryDatabaseAdapter` for the given `agentId`.

## Layout

```
plugins/plugin-inmemorydb/
  index.ts              Plugin entry — init hook, createDatabaseAdapter(), re-exports
  index.browser.ts      Browser entry — re-exports index.ts (different build target)
  adapter.ts            InMemoryDatabaseAdapter — full IDatabaseAdapter implementation
  storage-memory.ts     MemoryStorage — Map-of-Maps backing store (IStorage)
  hnsw.ts               EphemeralHNSW — cosine-distance HNSW vector index (IVectorStorage)
  types.ts              IStorage, IVectorStorage, VectorSearchResult, COLLECTIONS enum
  generated/specs/      Auto-generated specs (do not hand-edit)
  build.ts              tsdown build script
  vitest.config.ts      Test config
```

## Commands

```bash
bun run --cwd plugins/plugin-inmemorydb build       # compile to dist/
bun run --cwd plugins/plugin-inmemorydb dev         # build --watch
bun run --cwd plugins/plugin-inmemorydb test        # vitest run
bun run --cwd plugins/plugin-inmemorydb test:watch  # vitest watch
bun run --cwd plugins/plugin-inmemorydb typecheck   # tsgo --noEmit
bun run --cwd plugins/plugin-inmemorydb lint        # biome check --write
bun run --cwd plugins/plugin-inmemorydb format      # biome format --write
bun run --cwd plugins/plugin-inmemorydb clean       # rm -rf dist .turbo .turbo-tsconfig.json *.tsbuildinfo
```

## Config / env vars

None. This plugin reads no environment variables and requires no configuration. The `init` hook receives `config: Record<string, string>` but ignores it entirely.

## How to extend

The plugin exposes `IStorage` (in `types.ts`) as a stable interface. To swap the backing store:

1. Implement `IStorage` (all methods are async).
2. Instantiate `new InMemoryDatabaseAdapter(yourStorage, agentId)` directly instead of going through the plugin's `init` hook.
3. Call `adapter.initialize()` before use.

To add new collection types: add a key to `COLLECTIONS` in `types.ts`, then add CRUD methods to `InMemoryDatabaseAdapter` following the existing pattern (call `this.storage.set/get/getWhere/delete`).

To replace the vector index: implement `IVectorStorage` (in `types.ts`) and pass an instance into the adapter — the adapter currently creates `EphemeralHNSW` in its constructor; a minimal refactor exposes it as a constructor parameter.

## Conventions / gotchas

- **No persistence.** All data is lost when `close()` is called or the process exits. Do not use in production agents that need to remember past interactions.
- **Global singleton storage.** `MemoryStorage` is shared across all adapter instances in the same process via `Symbol.for(...)`. This means multiple agent runtimes in one process share state unless you construct `MemoryStorage` independently.
- **No transaction atomicity.** The `transaction()` method just invokes the callback with `this` — no rollback, no isolation.
- **Default embedding dimension is 384.** Call `adapter.ensureEmbeddingDimension(n)` before writing memories with a different embedding size; it updates the dimension on the HNSW index. Note: calling `init()` on the index only sets the dimension — existing vectors are NOT cleared. Call `clear()` explicitly if you need to discard existing vectors before changing dimension.
- **Batch API only.** Single-item helpers from earlier revisions are removed. All call sites must use batch methods (`createEntities`, `getMemoriesByIds`, etc.).
- **Browser build.** `index.browser.ts` re-exports `index.ts`. The build produces separate `dist/node/` and `dist/browser/` entries; the package `exports` map selects the right one automatically.
- **`node:crypto` dependency.** `adapter.ts` imports `randomUUID` from `node:crypto`. The browser build polyfills this via the build config; do not replace with `Math.random()`.
