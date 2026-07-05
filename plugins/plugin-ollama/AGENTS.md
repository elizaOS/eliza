# @elizaos/plugin-ollama

Local LLM inference via [Ollama](https://ollama.com/) for Eliza agents — text generation, streaming, structured output, embeddings, and native tool calling without any cloud API.

## Purpose / role

Registers model handlers for every text and embedding `ModelType` so an Eliza agent can run fully local inference against a running Ollama daemon. The plugin is **opt-in**: it auto-enables when `OLLAMA_BASE_URL` is set in the environment (see `auto-enable.ts` and `elizaos.plugin.autoEnableModule` in `package.json`). Add `@elizaos/plugin-ollama` to a character's plugin list to enable it explicitly without the env gate.

## Plugin surface

This plugin registers **model handlers only** — no actions, providers, services, evaluators, or routes.

| Model type | Handler | Description |
|---|---|---|
| `ModelType.TEXT_EMBEDDING` | `handleTextEmbedding` | Vector embeddings via AI SDK `embed` + `ollama-ai-provider-v2`. Auto-pulls model if missing. |
| `ModelType.TEXT_NANO` | `handleTextNano` | Cheapest/fastest text; defaults to `OLLAMA_NANO_MODEL` → `NANO_MODEL` → small model. |
| `ModelType.TEXT_SMALL` | `handleTextSmall` | Small text; defaults to `eliza-1-2b`. |
| `ModelType.TEXT_MEDIUM` | `handleTextMedium` | Medium text; defaults to small model when no medium override is set. |
| `ModelType.TEXT_LARGE` | `handleTextLarge` | Large text; defaults to `eliza-1-4b`. |
| `ModelType.TEXT_MEGA` | `handleTextMega` | Largest text; defaults to large model when no mega override is set. |
| `ModelType.RESPONSE_HANDLER` | `handleResponseHandler` | v5 Stage 1 message handler — accepts `messages`, `tools`, `toolChoice`; for planner streaming returns only the tool arguments JSON chunk. |
| `ModelType.ACTION_PLANNER` | `handleActionPlanner` | Action planning — same logic as `RESPONSE_HANDLER` via shared `handleTextWithModelType`. |

All text handlers share `models/text.ts:handleTextWithModelType`. Routing logic:
- `stream: true` + tools → `streamText` with tool set (Ollama v2 streaming `/api/chat`).
- `stream: true`, no tools, no schema, no `toolChoice` → `streamText` returning `TextStreamResult` for SSE.
- `stream: true` + `responseSchema` only → `generateText` (structured `format` stays on the completion path; logs at debug).
- All other cases → `generateText`.

## Layout

```
plugins/plugin-ollama/
  plugin.ts                  Plugin object; model-type → handler wiring; init (validates /api/tags)
  index.ts                   Re-exports plugin + types/config utilities; default export = ollamaPlugin
  index.node.ts              Node/Bun entry (dist target)
  index.browser.ts           Browser entry (dist target)
  auto-enable.ts             shouldEnable() — reads OLLAMA_BASE_URL; no runtime imports (type-only imports allowed)
  models/
    text.ts                  handleTextWithModelType and all exported text handlers
    embedding.ts             handleTextEmbedding
    availability.ts          ensureModelAvailable — /api/show → /api/pull if missing
    index.ts                 Re-exports handleTextEmbedding, handleTextLarge, handleTextSmall, ensureModelAvailable
  utils/
    config.ts                Settings resolution: getBaseURL, getSmallModel, getLargeModel, etc.
    ai-sdk-wire.ts           normalizeNativeTools, normalizeNativeMessages, normalizeToolChoice, mapAiSdkToolCallsToCore
    modelUsage.ts            emitModelUsed, estimateUsage, normalizeTokenUsage
    index.ts                 Re-exports config utilities
  types/
    index.ts                 OllamaConfig, TextGenerationParams, EmbeddingParams, etc.
  __tests__/                 Vitest unit tests
  build.ts                   Bun.build script (node + browser targets)
```

## Commands

```bash
bun run --cwd plugins/plugin-ollama build        # compile (node + browser)
bun run --cwd plugins/plugin-ollama dev          # watch mode
bun run --cwd plugins/plugin-ollama test         # vitest unit suite
bun run --cwd plugins/plugin-ollama lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-ollama format       # biome format --write
bun run --cwd plugins/plugin-ollama typecheck    # tsc --noEmit
bun run --cwd plugins/plugin-ollama clean        # rm dist/ .turbo/
```

## Config / env vars

All vars are read by `utils/config.ts` via `runtime.getSetting(key)` first, then `process.env`. This lets per-character `settings` override global `.env` without code changes.

| Var | Default | Required | Notes |
|---|---|---|---|
| `OLLAMA_API_ENDPOINT` / `OLLAMA_API_URL` | `http://localhost:11434` | No | Normalized to `…/api` internally. Absence triggers a warn but doesn't block start. `getBaseURL` tries these keys first, then `OLLAMA_BASE_URL`, then the default. |
| `OLLAMA_BASE_URL` | — | No | Optional auto-enable gate for `shouldEnable()`. `getBaseURL` also reads this as a fallback after `OLLAMA_API_ENDPOINT` / `OLLAMA_API_URL`. |
| `OLLAMA_SMALL_MODEL` / `SMALL_MODEL` | `eliza-1-2b` | No | TEXT_SMALL, fallback for NANO/MEDIUM/MEGA when unset. |
| `OLLAMA_LARGE_MODEL` / `LARGE_MODEL` | `eliza-1-4b` | No | TEXT_LARGE, fallback for MEGA when unset. |
| `OLLAMA_NANO_MODEL` / `NANO_MODEL` | → small model | No | TEXT_NANO. |
| `OLLAMA_MEDIUM_MODEL` / `MEDIUM_MODEL` | → small model | No | TEXT_MEDIUM. |
| `OLLAMA_MEGA_MODEL` / `MEGA_MODEL` | → large model | No | TEXT_MEGA. |
| `OLLAMA_EMBEDDING_MODEL` | `eliza-1-2b` | No | TEXT_EMBEDDING. |
| `OLLAMA_RESPONSE_HANDLER_MODEL` / `OLLAMA_SHOULD_RESPOND_MODEL` / `RESPONSE_HANDLER_MODEL` / `SHOULD_RESPOND_MODEL` | → nano model | No | RESPONSE_HANDLER. |
| `OLLAMA_ACTION_PLANNER_MODEL` / `OLLAMA_PLANNER_MODEL` / `ACTION_PLANNER_MODEL` / `PLANNER_MODEL` | → medium model | No | ACTION_PLANNER. |
| `OLLAMA_DISABLE_STRUCTURED_OUTPUT` | unset | No | `1`/`true`/`yes`/`on` strips `responseSchema` from every call. Use when a local model errors on `format`. |

## How to extend

**Add a new model handler:**
1. Add a helper function in `models/text.ts` calling `handleTextWithModelType` with the new `ModelType`.
2. Export it from `models/index.ts`.
3. Register it in `plugin.ts` inside the `models` map: `[ModelType.NEW_TYPE]: async (runtime, params) => handleNewType(runtime, params)`.

**Add a new config resolver:**
1. Add a `get<Type>Model(runtime)` function in `utils/config.ts` following the same `getSetting(runtime, "OLLAMA_<TYPE>_MODEL") || getSetting(runtime, "<TYPE>_MODEL") || fallback` pattern.
2. Import and call it from the handler in `models/text.ts`.

**No actions or services exist in this plugin.** If you need an action or service, add it in a separate plugin or in `packages/agent`.

## Conventions / gotchas

- **`ollama-ai-provider-v2` is required.** The old `ollama-ai-provider` exposed AI SDK model spec v1; `ai@6` only accepts v2+. Do not downgrade or swap the dependency.
- **`ensureModelAvailable`** fires before every inference call. It tries `/api/show`; if the model is absent it issues `/api/pull` (blocking, `stream: false`). This adds latency on first use.
- **Streaming + `RESPONSE_HANDLER` / `ACTION_PLANNER`:** When `stream: true` and tools are present, `textStream` yields only a single chunk — the first tool's `arguments` JSON. This is intentional so `parseMessageHandlerOutput` receives a clean JSON string. Do not yield arbitrary text deltas for planner types.
- **`AI_SDK_LOG_WARNINGS`** is set to `false` at module load to suppress Vercel AI SDK noise in tight loops / desktop shells. Unset it in dev if you need SDK diagnostics.
- **Browser build:** `package.json` exports a `browser` entry (`dist/browser/index.browser.js`). Keep `auto-enable.ts` free of Node-only imports.
- **Structured output + tools conflict:** When both `responseSchema` and `tools` are present, tools win — schema is dropped. This matches the v5 Stage 1 contract.
- See root `AGENTS.md` for repo-wide architecture rules, naming, logger usage, and git workflow.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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
