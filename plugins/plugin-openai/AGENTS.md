# @elizaos/plugin-openai

OpenAI model-provider plugin for elizaOS: text generation, embeddings, image generation/description, audio transcription, text-to-speech, and deep research via the OpenAI Responses API.

## Purpose / role

Registers model handlers on the elizaOS `AgentRuntime` so Eliza agents can call `runtime.useModel(ModelType.*, ...)` backed by OpenAI (or any OpenAI-compatible endpoint — Cerebras, EvoLink, OpenRouter, local servers). Auto-enables when `OPENAI_API_KEY`, `CEREBRAS_API_KEY`, or `EVOLINK_API_KEY` is present in the environment. No actions, providers, services, or evaluators — only model handlers.

## Plugin surface

This plugin registers **model handlers only** (no actions, providers, services, evaluators, routes, or events):

| `ModelType` | Default model | Handler |
|---|---|---|
| `TEXT_SMALL` | `gpt-5.4-mini` | `handleTextSmall` |
| `TEXT_NANO` | falls back to small | `handleTextNano` |
| `TEXT_MEDIUM` | falls back to small | `handleTextMedium` |
| `TEXT_LARGE` | `gpt-5` | `handleTextLarge` |
| `TEXT_MEGA` | falls back to large | `handleTextMega` |
| `RESPONSE_HANDLER` | falls back to small | `handleResponseHandler` |
| `ACTION_PLANNER` | falls back to medium | `handleActionPlanner` |
| `TEXT_EMBEDDING` | `text-embedding-3-small` | `handleTextEmbedding` |
| `TEXT_TOKENIZER_ENCODE` | js-tiktoken | `handleTokenizerEncode` |
| `TEXT_TOKENIZER_DECODE` | js-tiktoken | `handleTokenizerDecode` |
| `IMAGE` | `dall-e-3` | `handleImageGeneration` |
| `IMAGE_DESCRIPTION` | `gpt-5-mini` | `handleImageDescription` |
| `TRANSCRIPTION` | `gpt-5-mini-transcribe` | `handleTranscription` |
| `TEXT_TO_SPEECH` | `gpt-5-mini-tts` / voice `nova` | `handleTextToSpeech` |
| `RESEARCH` | `o3-deep-research` | `handleResearch` (Responses API) |

All text handlers support streaming (`params.stream = true`) and structured output (`params.responseSchema`).

## Layout

```
plugins/plugin-openai/
  index.ts               # Plugin object (openaiPlugin); registers all model handlers
  index.node.ts          # Node entrypoint
  index.browser.ts       # Browser entrypoint
  auto-enable.ts         # shouldEnable(): true when OPENAI_API_KEY, CEREBRAS_API_KEY, or EVOLINK_API_KEY set
  init.ts                # initializeOpenAI(): validates API key on startup; browser skips server-only validation
  build.ts               # Bun.build config (node ESM + browser ESM) + tsc declarations
  models/
    index.ts             # Re-exports all handlers
    text.ts              # handleTextSmall/Nano/Medium/Large/Mega/ResponseHandler/ActionPlanner
    embedding.ts         # handleTextEmbedding (deterministic local fallback in Cerebras mode)
    image.ts             # handleImageGeneration, handleImageDescription
    audio.ts             # handleTranscription, handleTextToSpeech
    tokenizer.ts         # handleTokenizerEncode, handleTokenizerDecode (js-tiktoken)
    research.ts          # handleResearch (OpenAI Responses API, o3/o4-mini deep research)
  providers/
    openai.ts            # createOpenAIClient(): @ai-sdk/openai factory (proxy-aware)
    index.ts
  utils/
    config.ts            # All getSetting/getModel/getBaseURL helpers; Cerebras/EvoLink detection
    events.ts            # emitModelUsageEvent: fires model-usage telemetry on runtime
    audio.ts             # detectAudioMimeType, getFilenameForMimeType
    tokenization.ts      # tiktoken helpers
    index.ts
  types/
    index.ts             # Plugin-local types: TTSVoice, ImageSize, TokenUsage, TextStreamResult,
                         #   OpenAIPluginConfig, API response shapes, etc.
  prompts/               # evaluators.json (empty manifest — plugin ships no evaluators)
  __tests__/             # Vitest unit tests
```

## Commands

```bash
bun run --cwd plugins/plugin-openai build          # Bun.build (node ESM + browser ESM) + tsc d.ts
bun run --cwd plugins/plugin-openai dev            # hot-reload build (bun --hot build.ts)
bun run --cwd plugins/plugin-openai test           # vitest unit suite
bun run --cwd plugins/plugin-openai typecheck      # tsgo --noEmit
bun run --cwd plugins/plugin-openai lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-openai lint:check     # biome check (read-only)
bun run --cwd plugins/plugin-openai format         # biome format --write
bun run --cwd plugins/plugin-openai clean          # rm -rf dist .turbo
```

## Config / env vars

All settings are read via `getSetting(runtime, key)` (runtime config first, then `process.env`).

| Var | Required | Default | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | yes* | — | Auth for all OpenAI endpoints |
| `CEREBRAS_API_KEY` | yes* | — | Auth when using Cerebras endpoint |
| `EVOLINK_API_KEY` | yes* | — | Auth when using EvoLink endpoint |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | Override API endpoint |
| `OPENAI_SMALL_MODEL` / `SMALL_MODEL` | no | `gpt-5.4-mini` | TEXT_SMALL model |
| `OPENAI_NANO_MODEL` / `NANO_MODEL` | no | falls back to small | TEXT_NANO model |
| `OPENAI_MEDIUM_MODEL` / `MEDIUM_MODEL` | no | falls back to small | TEXT_MEDIUM model |
| `OPENAI_LARGE_MODEL` / `LARGE_MODEL` | no | `gpt-5` | TEXT_LARGE model |
| `OPENAI_MEGA_MODEL` / `MEGA_MODEL` | no | falls back to large | TEXT_MEGA model |
| `OPENAI_RESPONSE_HANDLER_MODEL` | no | falls back to small | RESPONSE_HANDLER model |
| `OPENAI_ACTION_PLANNER_MODEL` | no | falls back to medium | ACTION_PLANNER model |
| `OPENAI_EMBEDDING_MODEL` | no | `text-embedding-3-small` | Embedding model |
| `OPENAI_EMBEDDING_URL` | no | `OPENAI_BASE_URL` | Override embeddings endpoint |
| `OPENAI_EMBEDDING_API_KEY` | no | `OPENAI_API_KEY` | Separate embedding auth |
| `OPENAI_EMBEDDING_DIMENSIONS` | no | `1536` | Embedding vector dimensions |
| `OPENAI_IMAGE_DESCRIPTION_MODEL` | no | `gpt-5-mini` | Vision model |
| `OPENAI_IMAGE_DESCRIPTION_BASE_URL` | no | `OPENAI_BASE_URL` | Override vision endpoint |
| `OPENAI_IMAGE_DESCRIPTION_API_KEY` | no | `OPENAI_API_KEY` | Separate vision auth |
| `OPENAI_IMAGE_DESCRIPTION_MAX_TOKENS` | no | `8192` | Max tokens for vision output |
| `OPENAI_IMAGE_MODEL` | no | `dall-e-3` | Image generation model |
| `OPENAI_TTS_MODEL` | no | `gpt-5-mini-tts` | Text-to-speech model |
| `OPENAI_TTS_VOICE` | no | `nova` | TTS voice (alloy/echo/fable/onyx/nova/shimmer) |
| `OPENAI_TTS_INSTRUCTIONS` | no | — | Style instructions for TTS |
| `OPENAI_TRANSCRIPTION_MODEL` | no | `gpt-5-mini-transcribe` | Audio transcription model |
| `OPENAI_RESEARCH_MODEL` | no | `o3-deep-research` | Deep research model |
| `OPENAI_RESEARCH_TIMEOUT` | no | `3600000` (1 hr) | Timeout for research requests (ms) |
| `OPENAI_EXPERIMENTAL_TELEMETRY` | no | `false` | Enable AI SDK telemetry |
| `OPENAI_REASONING_EFFORT` | no | — | `minimal`/`low`/`medium`/`high` for o-series models |
| `OPENAI_BROWSER_BASE_URL` | no | — | Browser-only proxy URL (keeps key server-side) |
| `OPENAI_BROWSER_EMBEDDING_URL` | no | — | Browser-only embeddings proxy URL |
| `OPENAI_ALLOW_BROWSER_API_KEY` | no | `false` | Send auth header in browser (opt-in) |
| `ELIZA_PROVIDER` | no | — | Set to `cerebras` or `evolink` to force that provider mode |
| `CEREBRAS_BASE_URL` | no | `https://api.cerebras.ai/v1` | Cerebras API base |
| `CEREBRAS_MODEL` | no | — | Override model name in Cerebras mode |
| `EVOLINK_BASE_URL` | no | `https://direct.evolink.ai/v1` | EvoLink API base |
| `EVOLINK_MODEL` | no | `gpt-5.2` | Override model name in EvoLink mode |

*Either `OPENAI_API_KEY`, `CEREBRAS_API_KEY`, or `EVOLINK_API_KEY` is required; the plugin will not auto-enable without one.

## How to extend

**Add a new model handler:**

1. Create `models/<name>.ts` exporting an async handler function matching the relevant `@elizaos/core` params/return type.
2. Re-export from `models/index.ts`.
3. Add a new `models: { [ModelType.NEW_TYPE]: async (runtime, params) => handler(runtime, params) }` entry in `index.ts`.
4. Add config helpers for any new env vars to `utils/config.ts`.

**Add a new model size tier:**

Model tiers (nano/medium/mega/response-handler/action-planner) all call the shared `generateTextByModelType()` in `models/text.ts`. Add a getter to `utils/config.ts` following the `OPENAI_<TIER>_MODEL` / `<TIER>_MODEL` fallback pattern, then wire it in `index.ts`.

## Conventions / gotchas

- **Dual build (node + browser).** Exports differ: `dist/node/index.node.js` and `dist/browser/index.browser.js`. Browser build avoids sending `Authorization` headers by default; set `OPENAI_BROWSER_BASE_URL` to a server-side proxy.
- **Cerebras mode.** Detected automatically from `ELIZA_PROVIDER=cerebras`, `OPENAI_BASE_URL` matching `*.cerebras.ai`, or presence of `CEREBRAS_API_KEY` without `OPENAI_API_KEY`. In Cerebras mode: structured output via `response_format: json_object` (not `json_schema`); `reasoning_effort` defaults to `"low"` for reasoning-capable models; `promptCacheRetention` is stripped (Cerebras rejects it); embeddings fall back to a deterministic local hash when no explicit embedding URL is set.
- **EvoLink mode.** Detected automatically from `ELIZA_PROVIDER=evolink`, `OPENAI_BASE_URL` matching `*.evolink.ai`, or presence of `EVOLINK_API_KEY` without a conflicting key. Uses `EVOLINK_BASE_URL` (default `https://direct.evolink.ai/v1`) and defaults to `gpt-5.2` as the model.
- **Reasoning models.** Pass `OPENAI_REASONING_EFFORT=low|medium|high` to control o-series / gpt-oss reasoning budgets. Valid values: `minimal`, `low`, `medium`, `high`.
- **Prompt caching.** Pass `providerOptions: { openai: { promptCacheKey: "...", promptCacheRetention: "24h" } }` on any `GenerateTextParams` call to enable OpenAI prompt caching.
- **Deep research.** `ModelType.RESEARCH` uses the OpenAI Responses API (`POST /responses`), not Chat Completions. It defaults to `o3-deep-research` and can take minutes to hours; use `params.background = true` for long jobs.
- **Tokenizer.** Uses `js-tiktoken` (WASM, browser-safe). `TEXT_TOKENIZER_ENCODE/DECODE` do not hit the network.
- **All API calls go through `recordLlmCall()`** from `@elizaos/core` for trajectory logging. Audio/embedding handlers carry a `// @trajectory-allow` comment where appropriate.
- **No barrel re-export of internal utils.** Import from `"../utils/config"`, `"../utils/events"`, etc. directly within the plugin.
- See root `AGENTS.md` for repo-wide architecture rules, logger conventions, ESM requirements, and naming standards.
