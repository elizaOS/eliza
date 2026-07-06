# @elizaos/plugin-local-storage

Local filesystem attachment storage for Eliza agents.

## Purpose / role

Registers `LocalFileStorageService` under `ServiceType.REMOTE_FILES` so Eliza agents have a zero-config, filesystem-backed file storage backend. It is the default fallback when Eliza Cloud storage is not connected. Loaded by including the package name in the agent's plugin list; it is opt-in (not globally auto-enabled). No actions, providers, evaluators, routes, or events are registered — the plugin surface is the service alone.

## Plugin surface

| Kind | Name | What it does |
|------|------|--------------|
| Service | `LocalFileStorageService` (`ServiceType.REMOTE_FILES`) | Reads/writes files under a configured root directory. Mirrors the API of the removed `AwsS3Service` so callers need no refactor. |

### `LocalFileStorageService` public methods

| Method | Signature | Notes |
|--------|-----------|-------|
| `uploadFile` | `(filePath, subDirectory?) → UploadResult` | Copies a file from disk into the storage root. |
| `uploadBytes` | `(data, fileName, contentType, subDirectory?) → UploadResult` | Writes a `Buffer` / `Uint8Array` under a fixed key. `contentType` is accepted for API parity but not persisted. |
| `uploadJson` | `(jsonData, fileName?, subDirectory?) → JsonUploadResult` | JSON-serializes an object and writes it. |
| `downloadBytes` | `(_unusedBucket, key) → Buffer` | Reads stored bytes. `_unusedBucket` is ignored. |
| `downloadFile` | `(_unusedBucket, key, localPath)` | Reads and writes to `localPath` on disk. |
| `delete` | `(_unusedBucket, key)` | Removes the stored object. Not idempotent — throws on missing key. |
| `exists` | `(_unusedBucket, key) → boolean` | Returns whether the key exists. |
| `generateSignedUrl` | `(fileName, _expiresIn?) → Promise<string>` | Returns a `file://` absolute URL. No expiry; `_expiresIn` is ignored. |
| `root` | getter `→ string` | Absolute path of the storage root. Useful for tests and tooling. |

Exported types from `src/types.ts`: `UploadResult`, `JsonUploadResult`, `JsonValue`, `JsonPrimitive`, `JsonObject`, `JsonArray`, `CONTENT_TYPES`, `getContentType`.

## Layout

```
plugins/plugin-local-storage/
  src/
    index.ts               Plugin definition — exports localStoragePlugin (default) and LocalFileStorageService
    types.ts               UploadResult, JsonUploadResult, JsonValue hierarchy, CONTENT_TYPES map, getContentType()
    services/
      local-storage.ts     LocalFileStorageService — resolveStorageRoot(), all read/write methods
  build.ts                 Build entrypoint (Bun.build, Node ESM only)
  vitest.config.ts         Test config
  package.json
```

## Commands

```bash
bun run --cwd plugins/plugin-local-storage build        # compile to dist/
bun run --cwd plugins/plugin-local-storage dev          # watch build (--hot)
bun run --cwd plugins/plugin-local-storage test         # vitest run
bun run --cwd plugins/plugin-local-storage typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-local-storage lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-local-storage lint:check   # biome check (read-only)
bun run --cwd plugins/plugin-local-storage format       # biome format --write
bun run --cwd plugins/plugin-local-storage clean        # rm dist/ + turbo caches
```

## Config / env vars

| Setting | Source priority | Required | Notes |
|---------|----------------|----------|-------|
| `LOCAL_STORAGE_PATH` | 1. `runtime.getSetting("LOCAL_STORAGE_PATH")` 2. `process.env.LOCAL_STORAGE_PATH` 3. `<resolveStateDir()>/attachments` | No | Absolute path to the storage root. Directory is created on `start()` if missing. |

## How to extend

**Add a method to `LocalFileStorageService`:**
1. Implement the method in `src/services/local-storage.ts`.
2. If the method returns a new result shape, add the type to `src/types.ts` and re-export it from `src/index.ts`.
3. No plugin registration change needed — the service is already registered.

**Add a new service:**
1. Create `src/services/<name>.ts` extending `Service` from `@elizaos/core`.
2. Import and add it to the `services` array in `src/index.ts`.
3. If the service needs cleanup, add a `dispose` call alongside the existing one in `index.ts`.

**Add an action:**
1. Create `src/actions/<name>.ts` implementing the `Action` interface from `@elizaos/core`.
2. Import and push it into the `actions` array in `src/index.ts`.

## Conventions / gotchas

- **Node-only.** The `eliza.runtime` field in `package.json` is `"node"`. This plugin uses `node:fs` and `node:path` and will not run in a browser or React Native context.
- **`_unusedBucket` params.** All download/delete/exists methods accept a bucket string as the first argument for API parity with the removed S3 service. The value is always ignored.
- **`generateSignedUrl` returns a permanent `file://` URL.** There is no expiry. If the caller needs a public or expiring URL, route storage through Eliza Cloud instead.
- **`@brighter/storage-adapter-local`** is the only non-elizaOS runtime dependency. The plugin's internal `LocalStorage` interface wraps only the subset of that adapter that is actually used, so the upstream's loose `string | Buffer` return types do not leak into the public API.
- **Removing the service** (e.g. to replace it): call `runtime.getService(ServiceType.REMOTE_FILES)?.stop()` before unregistering, or rely on the `dispose` hook on the plugin object.
- For repo-wide architecture rules, logging conventions, ESM requirements, and naming, see the root `AGENTS.md`.

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
