# @elizaos/plugin-localdb

Persistent local database adapter for elizaOS — JSON-file storage on Node.js, `localStorage` in the browser.

## Purpose / role

Provides a file-backed (Node.js) and `localStorage`-backed (browser) `IDatabaseAdapter` for Eliza agents that need persistence across restarts without a full database server. It wraps `InMemoryDatabaseAdapter` from `@elizaos/plugin-inmemorydb` with a durable storage backend. The plugin is opt-in — its `init` hook silently exits if the runtime already has an adapter registered.

Load it by adding `@elizaos/plugin-localdb` to an agent's plugin list. It has two build entries: `dist/index.js` (Node.js, file-backed) and `dist/index.browser.js` (browser, `localStorage`-backed).

## Plugin surface

No actions, providers, evaluators, routes, or events are registered. The sole contribution is a `DatabaseAdapter`.

| What | Name | Where |
|------|------|--------|
| Plugin object (Node) | `plugin` / `default` | `index.ts` |
| Plugin object (browser) | `plugin` / `default` | `index.browser.ts` |
| Adapter factory (Node) | `createDatabaseAdapter(agentId, dataDir)` | `index.ts` |
| Adapter factory (browser) | `createDatabaseAdapter(agentId)` | `index.browser.ts` |
| Storage class (Node) | `FileStorage` | `index.ts` (unexported) |
| Storage class (browser) | `BrowserLocalStorage` | `index.browser.ts` (unexported) |
| Adapter class | `InMemoryDatabaseAdapter` | imported by entries from `@elizaos/plugin-inmemorydb` |
| Storage interface | `IStorage` | imported by entries from `@elizaos/plugin-inmemorydb` |

The entry files (`index.ts`, `index.browser.ts`) import only `InMemoryDatabaseAdapter` and `IStorage`. The package `@elizaos/plugin-inmemorydb` also exports `EphemeralHNSW` (vector index) and `COLLECTIONS`, but those are not referenced by this plugin's entry points — the adapter manages its own HNSW index internally.

`init` hook behavior: checks `r.adapter`, `r.databaseAdapter`, and `r.hasDatabaseAdapter()` — exits if any adapter is present. Otherwise resolves the data directory via `LOCALDB_DATA_DIR` setting or env var (fallback: `.eliza-localdb/` in `process.cwd()`), constructs a `FileStorage`, wraps it in `InMemoryDatabaseAdapter`, initializes it, calls `r.registerDatabaseAdapter()`, and logs `Local database adapter registered`. The browser `init` does the same minus the log line.

## Layout

```
plugins/plugin-localdb/
  index.ts              Node plugin entry — FileStorage, plugin object, createDatabaseAdapter()
  index.browser.ts      Browser plugin entry — BrowserLocalStorage, plugin object, createDatabaseAdapter()
  adapter.ts            InMemoryDatabaseAdapter — local copy (NOT used by plugin entries; plugin imports from @elizaos/plugin-inmemorydb)
  hnsw.ts               EphemeralHNSW — local copy used only by adapter.ts
  types.ts              IStorage, IVectorStorage, VectorSearchResult, COLLECTIONS — local copy used only by adapter.ts
  tsup.config.ts        Dual-entry build (index + index.browser), ESM only
```

Note: `adapter.ts`, `hnsw.ts`, and `types.ts` are local copies of the equivalent files in `plugin-inmemorydb` but are NOT imported by `index.ts` or `index.browser.ts`. The plugin entries import only `InMemoryDatabaseAdapter` and `IStorage` from `@elizaos/plugin-inmemorydb`. The local copies are dead weight; if the upstream adapter is patched, no sync to these files is required for the plugin to function.

## Commands

```bash
bun run --cwd plugins/plugin-localdb build       # compile to dist/
bun run --cwd plugins/plugin-localdb dev         # build --watch
bun run --cwd plugins/plugin-localdb typecheck   # tsgo --noEmit
bun run --cwd plugins/plugin-localdb clean       # rm -rf dist .turbo
```

Lint and test scripts are no-ops in this package (`echo "Lint skipped"` / `echo "No tests"`).

## Config / env vars

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `LOCALDB_DATA_DIR` | No | `.eliza-localdb/` (cwd) | Directory where `localdb.json` is written on Node.js. Readable as an agent setting or process env var. |

The browser entry uses `localStorage` keyed by `elizaos:localdb:<agentId>`. No env vars apply.

## How to extend

To swap the backing store without forking the plugin:

1. Implement `IStorage` from `@elizaos/plugin-inmemorydb` (all methods async).
2. Call `new InMemoryDatabaseAdapter(yourStorage, agentId)` directly.
3. Call `adapter.initialize()` before registering with the runtime.

To add a new collection: add a key to `COLLECTIONS` in `@elizaos/plugin-inmemorydb`'s `types.ts`, then add CRUD methods in the adapter following the existing pattern (`this.storage.set/get/getWhere/delete`).

## Conventions / gotchas

- **Flush-on-write.** `FileStorage` awaits a full `writeFile` after every mutation. This is safe for small datasets but not designed for high-write throughput.
- **Adapter gate.** The plugin will not register a second adapter. If another plugin (e.g., a SQL adapter) loads first, this plugin does nothing. Load order matters.
- **No transaction atomicity.** `transaction()` calls the callback with `this` — no rollback.
- **HNSW is ephemeral.** The vector index is rebuilt from scratch on each process start; embeddings stored in `localdb.json` are not re-indexed automatically. Semantic search results are empty until new memories with embeddings are written after startup.
- **Default embedding dimension is 384.** Call `adapter.ensureEmbeddingDimension(n)` before writing memories with a different size; when `n` differs from the current dimension it re-inits the HNSW index with the new dimension (subsequent `add()` calls validate against it).
- **Batch API only.** No single-item helpers. Use `createEntities`, `getMemoriesByIds`, etc.
- **Local copies are unused.** `adapter.ts`, `hnsw.ts`, and `types.ts` exist in this package but are not imported by either entry point. The plugin uses the versions from `@elizaos/plugin-inmemorydb`.
- **Browser entry is separate.** The `exports` map routes `browser` consumers to `dist/index.browser.js`. Do not import from `index.ts` directly in a browser context.
