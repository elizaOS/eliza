# @elizaos/plugin-zerollama

Local LLM inference via [Ollama](https://ollama.com/)-compatible servers for Eliza agents — text generation, streaming, structured output, embeddings, and native tool calling without any cloud API. Auto-detects zerollama vs stock Ollama via `GET /api/version` and uses native zerollama wire format when available.

## Purpose / role

Registers model handlers for every text and embedding `ModelType` so an Eliza agent can run fully local inference against a running Ollama or zerollama daemon. The plugin is **opt-in**: it auto-enables when `OLLAMA_BASE_URL` is set in the environment (see `auto-enable.ts` and `elizaos.plugin.autoEnableModule` in `package.json`). Add `@elizaos/plugin-zerollama` to a character's plugin list to enable it explicitly without the env gate.

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
| `ModelType.TEXT_TO_SPEECH` | `handleTextToSpeech` | Opt-in OpenAI-compatible speech via zerollama Piper; requires `OLLAMA_TTS_MODEL`. |
| `ModelType.TRANSCRIPTION` | `handleTranscription` | Opt-in OpenAI-compatible transcription; requires `OLLAMA_TRANSCRIPTION_MODEL`. |

All text handlers share `models/text.ts:handleTextWithModelType`. Routing logic:
- `stream: true` + tools → `streamText` with tool set (Ollama v2 streaming `/api/chat`).
- `stream: true`, no tools, no schema, no `toolChoice` → `streamText` returning `TextStreamResult` for SSE.
- `stream: true` + `responseSchema` only → `generateText` (structured `format` stays on the completion path; logs at debug).
- All other cases → `generateText`.

## Layout

```
plugins/plugin-zerollama/
  plugin.ts                  Plugin object (name: "zerollama"); model-type → handler wiring; init (validates /api/tags)
  index.ts                   Re-exports ollamaPlugin and zerollamaPlugin; default export = ollamaPlugin
  index.node.ts              Node/Bun entry (dist target)
  index.browser.ts           Browser entry (dist target)
  auto-enable.ts             shouldEnable() — reads OLLAMA_BASE_URL/OLLAMA_API_ENDPOINT/OLLAMA_API_URL; no runtime imports
  models/
    availability.ts          Checks model availability and pulls missing models
    text.ts                  handleTextWithModelType and all exported text handlers
    embedding.ts             handleTextEmbedding
    audio.ts                 handleTextToSpeech, handleTranscription
    zerollama-text.ts        Native zerollama /api/chat text handler
    index.ts                 Re-exports handleTextEmbedding, handleTextLarge, handleTextSmall, ensureModelAvailable
  utils/
    ai-sdk-wire.ts           Converts Eliza messages, schemas, and tools to AI SDK inputs
    config.ts                Settings resolution: getBaseURL, getSmallModel, getLargeModel, etc.
    host-flavor.ts           resolveOllamaHostFlavor — zerollama vs stock-Ollama detection via /api/version
    ollama-chat-compat-fetch.ts  Native zerollama /api/chat client (no AI SDK wire layer)
    embed-context.ts         Embedding context helpers for zerollama native path
    modelUsage.ts            Normalizes usage and emits model-use telemetry
    index.ts                 Re-exports config utilities
  __tests__/                 Vitest unit tests (shape tests for each model handler)
  build.ts                   buildPlugin script (node + browser + cjs targets)
```

## Commands

```bash
bun run --cwd plugins/plugin-zerollama build        # compile (node + browser + cjs)
bun run --cwd plugins/plugin-zerollama dev          # watch mode
bun run --cwd plugins/plugin-zerollama test         # vitest unit suite
bun run --cwd plugins/plugin-zerollama lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-zerollama format       # biome format --write
bun run --cwd plugins/plugin-zerollama typecheck    # tsc --noEmit
bun run --cwd plugins/plugin-zerollama clean        # rm dist/ .turbo/
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
| `OLLAMA_HOST_FLAVOR` | auto via `GET /api/version` | No | Pin `zerollama` or `ollama`. Zerollama uses a native `/api/chat` + `/api/embed` client (no AI SDK wire aliases); stock Ollama keeps `ollama-ai-provider-v2`. |
| `OLLAMA_RESPONSE_HANDLER_MODEL` / `OLLAMA_SHOULD_RESPOND_MODEL` / `RESPONSE_HANDLER_MODEL` / `SHOULD_RESPOND_MODEL` | → nano model | No | RESPONSE_HANDLER. |
| `OLLAMA_ACTION_PLANNER_MODEL` / `OLLAMA_PLANNER_MODEL` / `ACTION_PLANNER_MODEL` / `PLANNER_MODEL` | → medium model | No | ACTION_PLANNER. |
| `OLLAMA_DISABLE_STRUCTURED_OUTPUT` | unset | No | `1`/`true`/`yes`/`on` strips `responseSchema` from every call. Use when a local model errors on `format`. |
| `OLLAMA_TTS_MODEL` / `OLLAMA_SPEECH_MODEL` | unset | No | Enables `TEXT_TO_SPEECH` via `POST /v1/audio/speech` (zerollama Piper). When set, `/api/tts/local-inference` prefers `ollama` over Kokoro. |
| `OLLAMA_TTS_VOICE` / `OLLAMA_SPEECH_VOICE` | unset | No | Optional Piper voice name (`voice` JSON field). |
| `OLLAMA_TTS_SPEED` / `OLLAMA_SPEECH_SPEED` | unset | No | Optional speed 0.25–4.0. |
| `OLLAMA_TRANSCRIPTION_MODEL` / `OLLAMA_ASR_MODEL` | unset | No | Enables `TRANSCRIPTION` via `POST /v1/audio/transcriptions`. When set, `/api/asr/local-inference` prefers `ollama` over on-device ASR. |

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
- **Streaming + `RESPONSE_HANDLER` / `ACTION_PLANNER`:** When `stream: true` and tools are present, `textStream` yields only a single chunk — the first tool's `arguments` JSON. This is intentional so `parseMessageHandlerOutput` receives a clean JSON string. Do not yield arbitrary text deltas for planner types. If the model returns **no** tool call (common on zerollama, where `tool_choice` is deliberately omitted from the native wire), both paths fall back to yielding the full accumulated plan text instead of nothing — the native `zerollamaChatStream` mirrors the AI-SDK sibling's `fallbackText` yield in `models/text.ts` — so core's textStream-only accumulator still receives the plan the model produced rather than parsing an empty string.
- **`AI_SDK_LOG_WARNINGS`** is set to `false` at module load to suppress Vercel AI SDK noise in tight loops / desktop shells. Unset it in dev if you need SDK diagnostics.
- **Browser build:** `package.json` exports a `browser` entry (`dist/browser/index.browser.js`). Keep `auto-enable.ts` free of Node-only imports.
- **Structured output + tools conflict:** When both `responseSchema` and `tools` are present, tools win — schema is dropped. This matches the v5 Stage 1 contract.
- See root `AGENTS.md` for repo-wide architecture rules, naming, logger usage, and git workflow.

## Live evidence

Follow the repository evidence policy in [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Before
shipping provider behavior, exercise the real daemon and inspect the request, raw response,
usage, finish reason, streamed chunks, tool calls, structured output, and relevant failure
paths. Deterministic unit tests remain required but are not a substitute for the live run.
