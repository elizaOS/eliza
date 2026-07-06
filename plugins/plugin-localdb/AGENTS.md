# @elizaos/plugin-localdb

Persistent local database adapter for elizaOS — JSON-file storage on Node.js, `localStorage` in the browser.

## Purpose / role

Provides a file-backed (Node.js) and `localStorage`-backed (browser) `IDatabaseAdapter` for Eliza agents that need persistence across restarts without a full database server. It wraps `InMemoryDatabaseAdapter` from `@elizaos/plugin-inmemorydb` with a durable storage backend. The plugin is opt-in — its `init` hook leaves the existing adapter in place if the runtime already has one registered.

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
  tsup.config.ts        Dual-entry build (index + index.browser), ESM only
```

The plugin entries import `InMemoryDatabaseAdapter` and `IStorage` from `@elizaos/plugin-inmemorydb`; local adapter/vector copies are intentionally absent so the package follows the shared adapter implementation.

## Commands

```bash
bun run --cwd plugins/plugin-localdb build       # compile to dist/
bun run --cwd plugins/plugin-localdb dev         # build --watch
bun run --cwd plugins/plugin-localdb typecheck   # tsgo --noEmit
bun run --cwd plugins/plugin-localdb lint        # biome check --write --unsafe .
bun run --cwd plugins/plugin-localdb lint:check  # biome check .
bun run --cwd plugins/plugin-localdb test        # vitest run
bun run --cwd plugins/plugin-localdb clean       # rm -rf dist .turbo
```

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
- **Adapter gate.** The plugin will not register a second adapter. If another plugin (e.g., a SQL adapter) loads first, this plugin leaves that adapter in place. Load order matters.
- **No transaction atomicity.** `transaction()` calls the callback with `this` — no rollback.
- **HNSW is ephemeral.** The vector index is rebuilt from scratch on each process start; embeddings stored in `localdb.json` are not re-indexed automatically. Semantic search results are empty until new memories with embeddings are written after startup.
- **Default embedding dimension is 384.** Call `adapter.ensureEmbeddingDimension(n)` before writing memories with a different size; when `n` differs from the current dimension it re-inits the HNSW index with the new dimension (subsequent `add()` calls validate against it).
- **Batch API only.** No single-item helpers. Use `createEntities`, `getMemoriesByIds`, etc.
- **Browser entry is separate.** The `exports` map routes `browser` consumers to `dist/index.browser.js`. Do not import from `index.ts` directly in a browser context.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
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

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — storage / memory:**
- The actual rows / embeddings / documents written **and read back**, with their shape inspected — not a mock asserting itself.
- Query correctness: precision/recall on real data, ordering, pagination, and migration up/down.
- GC/retention, concurrency, and large-payload paths.
- A trajectory showing memory/knowledge actually recalled into a turn, where relevant.
<!-- END: evidence-and-e2e-mandate -->
