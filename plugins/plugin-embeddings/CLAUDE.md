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

**Capture & manually review for this package — model provider:**
- A trajectory from a **live** call to this provider (not the proxy, not a mock): full request, raw response, token usage, finish reason, and streamed chunks.
- Proof of tool/function-calling and structured-output parsing against the real model.
- The error paths exercised: bad key, model-not-found, oversized context, timeout, rate-limit, mid-stream disconnect — plus latency and cost from the real call.
- If no key is available in CI, attach the documented live-run transcript as evidence — never a mocked client passed off as a pass.
<!-- END: evidence-and-e2e-mandate -->
