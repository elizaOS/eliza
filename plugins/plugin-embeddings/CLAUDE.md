# @elizaos/plugin-embeddings

Provider-agnostic ("bring your own") `TEXT_EMBEDDING` provider for elizaOS agents. Points a single set of `EMBEDDING_*` vars at any OpenAI-compatible `/embeddings` endpoint, independent of the chat brain.

## Purpose / role

Decouples embeddings from text generation. A self-hosted bot whose chat provider serves no good embeddings — Claude (no embeddings API), Cerebras (no embeddings) — can still get high-quality vectors by setting `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` to a personal OpenAI key, an Eliza Cloud URL, Voyage, or a local TEI / Infinity / vLLM / LM Studio server.

**Purely additive.** The plugin auto-enables **only** when `EMBEDDING_BASE_URL` or `EMBEDDING_API_KEY` is set (see `auto-enable.ts`). With neither set it never loads, so existing deployments — which use their chat provider's embedding slot, local inference, or Eliza Cloud — are unaffected.

It registers **only the embedding slots** — no text/image/audio handlers, no actions, providers, services, or evaluators.

## Plugin surface

| Model type | Handler | File |
|---|---|---|
| `ModelType.TEXT_EMBEDDING` | `handleTextEmbedding` | `src/models/embedding.ts` |
| `ModelType.TEXT_EMBEDDING_BATCH` | `handleBatchTextEmbedding` | `src/models/embedding.ts` |

Both POST `{ model, input, ...(explicit dimensions ? { dimensions } : {}) }` to `` `${EMBEDDING_BASE_URL}/embeddings` `` using raw `fetch` (no `@ai-sdk` dependency), parse the OpenAI-compatible response, validate the returned width against the configured dimension, and emit a `MODEL_USED` event.

### Registration priority

The plugin registers at **`priority: 1`**. The native priority sort for the embedding slot is:

```
local-inference @ 0  <  plugin-embeddings @ 1  <  Eliza Cloud @ 50
```

So a bring-your-own endpoint **beats a bare local embedder** but **yields to a paired Eliza Cloud**. This is the desired default; override per-slot via the runtime routing preferences when a different precedence is wanted.

### Error policy (Commandment 8 / issue #9324)

On **any** HTTP, config, or response-shape error the handler **THROWS** — it never returns a zero or fabricated vector, which would silently corrupt the embedding store. The single legitimate synthetic return is the boot dimension-probe: the runtime calls `useModel(TEXT_EMBEDDING, null)` purely to read `.length`, so a correctly-sized marker vector (`[0.1, 0, 0, …]`) is returned for `null` input only. There is **no Cerebras deterministic-fallback branch** (dropped from the lifted OpenAI handler) and **no default endpoint** — a missing `EMBEDDING_BASE_URL` throws.

## Layout

```
plugins/plugin-embeddings/
  index.ts / index.node.ts / index.browser.ts   Build entrypoints (re-export src/index)
  auto-enable.ts        Manifest entry-point — env-only shouldEnable (no transitive imports)
  build.ts              Bun.build (node + browser + cjs) + tsc declarations
  src/
    index.ts            embeddingsPlugin — models map + init() config validation/logging
    models/
      embedding.ts      handleTextEmbedding + handleBatchTextEmbedding (raw fetch, THROW on error)
      index.ts          Re-exports handlers
    utils/
      config.ts         Provider-neutral getSetting-based getters
      events.ts         emitModelUsageEvent (MODEL_USED)
    types/
      index.ts          EmbeddingResponse, TokenUsage
  __tests__/
    embedding.test.ts   Null-probe width, wire-mocked vector, dimension-mismatch/empty/unsupported throws, batch, VECTOR_DIMS contract
    config.test.ts      Provider-neutral getter resolution + no chat fallback
    auto-enable.test.ts shouldEnable opt-in semantics
```

## Commands

```bash
bun run --cwd plugins/plugin-embeddings build        # Bun.build (node + browser + cjs) + tsc d.ts
bun run --cwd plugins/plugin-embeddings dev          # watch build
bun run --cwd plugins/plugin-embeddings test         # vitest unit suite
bun run --cwd plugins/plugin-embeddings typecheck    # tsc --noEmit --noCheck
bun run --cwd plugins/plugin-embeddings lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-embeddings lint:check   # biome check (read-only)
bun run --cwd plugins/plugin-embeddings format       # biome format --write
bun run --cwd plugins/plugin-embeddings clean        # rm -rf dist .turbo …
```

## Config / env vars

All read via `getSetting(runtime, key)` (runtime/character config first, then `process.env`), so every value is per-character overridable. There is **no fallback** to a chat provider's settings (`OPENAI_*`, `ELIZAOS_CLOUD_*`, …) — this plugin owns the embedding slot independently.

| Var | Required | Default | Purpose |
|---|---|---|---|
| `EMBEDDING_BASE_URL` | one-of* | — | Base URL of an OpenAI-compatible `/embeddings` endpoint. No default — unset throws. |
| `EMBEDDING_API_KEY` | one-of* | — | Bearer token for the endpoint. Omit for local servers needing no auth. |
| `EMBEDDING_MODEL` | no | `text-embedding-3-small` | Model id sent as the request `model` field. |
| `EMBEDDING_DIMENSIONS` | no | `1536` | Vector width. When explicitly set, sent as the request `dimensions` field. |
| `EMBEDDING_BROWSER_URL` | no | — | Browser-only server-side proxy URL. In a browser build the `Authorization` header is sent **only** when this is set, keeping the key server-side. |

\* Setting **either** `EMBEDDING_BASE_URL` or `EMBEDDING_API_KEY` is what activates the plugin. For real (non-probe) embedding calls a `EMBEDDING_BASE_URL` is required or the handler throws.

### Supported dimensions

`EMBEDDING_DIMENSIONS` must be one of the elizaOS `VECTOR_DIMS` (imported from `@elizaos/core`):

```
384, 512, 768, 1024, 1536, 2048, 3072
```

An unsupported value throws at boot and on every call.

### Stable-dimension-per-DB caveat

The embedding dimension is part of the database vector schema. **Keep `EMBEDDING_DIMENSIONS` (and the model) stable for the lifetime of a database.** Changing the width invalidates every stored vector — existing rows become unsearchable / get dropped on dimension mismatch. To switch dimensions, re-embed the corpus into a fresh store.

## How to extend

This plugin is intentionally embedding-only. To add another OpenAI-compatible embedding behavior, add a helper in `src/models/embedding.ts`, re-export from `src/models/index.ts`, and (if a new slot) wire it into the `models` map in `src/index.ts`. Add any new env var to `src/utils/config.ts` (follow the `getSetting` pattern) and to `agentConfig.pluginParameters` in `package.json`.

## Registration / discovery

No central list edit is needed. The plugin lives under the repo `plugins/*` workspace glob (so `bun install` symlinks it into `node_modules`) and declares `elizaos.plugin.autoEnableModule` in `package.json`. The agent's plugin-candidate discovery (`packages/agent/src/runtime/plugin-resolver.ts → discoverPluginCandidates`) walks `node_modules` **and** the workspace `plugins/` dir, reads each `elizaos.plugin` manifest, and the auto-enable engine (`packages/shared/src/config/plugin-manifest.ts`) runs `shouldEnable`. This is identical to how `plugin-lmstudio` is wired — neither plugin appears in `core-plugins.ts` nor as a dep of `packages/agent`.

## Conventions / gotchas

- **Raw `fetch`, no `@ai-sdk`.** Mirrors plugin-openai's transport. The only runtime dependency is `@elizaos/core` (peer/`workspace:*`).
- **THROW, never fabricate.** Any failure throws so the runtime falls through to another provider instead of persisting a corrupt vector.
- **Browser key safety.** The `Authorization` header is suppressed in browser builds unless `EMBEDDING_BROWSER_URL` is set (the proxy injects auth server-side).
- **Dual build (node + browser).** `dist/node/index.node.js` and `dist/browser/index.browser.js`.
- See the repo-root `AGENTS.md` for logger-only, ESM, naming, and architecture rules.
