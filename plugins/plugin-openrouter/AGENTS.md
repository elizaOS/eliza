# @elizaos/plugin-openrouter

OpenRouter multi-model AI gateway plugin for elizaOS.

## Purpose / role

Provides text generation, image description, image generation, and text embedding capabilities to any Eliza agent by routing requests through the [OpenRouter](https://openrouter.ai) API. The plugin registers model handlers — no actions, providers, services, or evaluators. It auto-enables when `OPENROUTER_API_KEY` is present in the environment (see `auto-enable.ts` and the `elizaos.plugin.autoEnableModule` field in `package.json`). Ships dual builds: `node` (default) and `browser` (no Authorization header; use `OPENROUTER_BROWSER_BASE_URL` proxy instead).

## Plugin surface

No actions, services, evaluators, providers, or routes. This plugin registers **model handlers only**:

| `ModelType` | Handler | Default model |
|---|---|---|
| `TEXT_NANO` | `handleTextNano` | falls back to small model |
| `TEXT_SMALL` | `handleTextSmall` | `google/gemini-2.0-flash-001` |
| `TEXT_MEDIUM` | `handleTextMedium` | falls back to small model |
| `TEXT_LARGE` | `handleTextLarge` | `google/gemini-2.5-flash` |
| `TEXT_MEGA` | `handleTextMega` | falls back to large model |
| `RESPONSE_HANDLER` | `handleResponseHandler` | falls back to nano model |
| `ACTION_PLANNER` | `handleActionPlanner` | falls back to medium model |
| `IMAGE_DESCRIPTION` | `handleImageDescription` | `x-ai/grok-2-vision-1212` |
| `IMAGE` | `handleImageGeneration` | `google/gemini-2.5-flash-image-preview` |
| `TEXT_EMBEDDING` | `handleTextEmbedding` | `openai/text-embedding-3-small` (1536 dims) |
| `TRANSCRIPTION` | `handleTranscription` | `openai/whisper-large-v3` |

All text handlers support streaming (`params.stream = true`), `tools`/`toolChoice`, and `responseSchema` for structured JSON output. Sampling parameters (temperature, frequencyPenalty, presencePenalty) are suppressed for `openai/*`, `anthropic/*`, and reasoning models (o1/o3/o4, gpt-5, gpt-5-mini) to avoid API errors. Every handler emits a `MODEL_USED` event via `utils/events.ts` after each call.

## Layout

```
plugins/plugin-openrouter/
  index.ts                  Public exports: re-exports plugin + types + config helpers
  plugin.ts                 Plugin object definition (model registrations, config, tests)
  init.ts                   initializeOpenRouter() — validates API key at boot (node only)
  auto-enable.ts            shouldEnable() — checked by elizaOS plugin loader at boot
  models/
    audio.ts                TRANSCRIPTION handler (direct fetch to /audio/transcriptions)
    text.ts                 All text model handlers (nano/small/medium/large/mega/response-handler/action-planner)
    image.ts                IMAGE_DESCRIPTION and IMAGE generation handlers
    embedding.ts            TEXT_EMBEDDING handler (direct fetch to /embeddings endpoint)
  providers/
    openrouter.ts           createOpenRouterProvider() — wraps @openrouter/ai-sdk-provider
    index.ts                Re-export
  utils/
    config.ts               getApiKey, getBaseURL, get*Model, getEmbeddingDimensions, shouldAutoCleanupImages
    events.ts               emitModelUsageEvent() — emits EventType.MODEL_USED with token counts
    helpers.ts              Shared utilities
    index.ts                Re-export
  types/
    index.ts                Plugin-local TypeScript interfaces (OpenRouterConfig, TextGenerationParams, etc.)
  __tests__/                Unit + live integration tests
  build.ts                  Bun build script (node ESM + browser ESM + CJS outputs)
```

## Commands

```bash
bun run --cwd plugins/plugin-openrouter build          # bun build.ts (node ESM + browser ESM + CJS)
bun run --cwd plugins/plugin-openrouter dev            # hot-rebuild watch mode
bun run --cwd plugins/plugin-openrouter test           # vitest unit suite
bun run --cwd plugins/plugin-openrouter test:unit      # __tests__/ only
bun run --cwd plugins/plugin-openrouter test:watch     # vitest watch
bun run --cwd plugins/plugin-openrouter typecheck      # tsc --noEmit
bun run --cwd plugins/plugin-openrouter lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-openrouter format         # biome format --write
bun run --cwd plugins/plugin-openrouter clean          # rm dist .turbo tsconfig.tsbuildinfo
```

Live integration tests (require real API key) use `vitest.live.config.ts` — not run in CI.

## Config / env vars

Settings are read via `runtime.getSetting(key)` first, then `process.env[key]`. Plugin-specific vars take priority over generic fallbacks.

| Env var | Required | Default | Description |
|---|---|---|---|
| `OPENROUTER_API_KEY` | **yes** | — | OpenRouter API key. Auto-enable gating key. |
| `OPENROUTER_BASE_URL` | no | `https://openrouter.ai/api/v1` | API endpoint override. |
| `OPENROUTER_BROWSER_BASE_URL` | no | — | Proxy URL used in browser builds (no API key in client). |
| `OPENROUTER_SMALL_MODEL` | no | `google/gemini-2.0-flash-001` | Override for TEXT_SMALL/TEXT_NANO/TEXT_MEDIUM base. |
| `OPENROUTER_LARGE_MODEL` | no | `google/gemini-2.5-flash` | Override for TEXT_LARGE/TEXT_MEGA base. |
| `OPENROUTER_NANO_MODEL` | no | — | Override for TEXT_NANO specifically. |
| `OPENROUTER_MEDIUM_MODEL` | no | — | Override for TEXT_MEDIUM specifically. |
| `OPENROUTER_MEGA_MODEL` | no | — | Override for TEXT_MEGA specifically. |
| `OPENROUTER_RESPONSE_HANDLER_MODEL` | no | — | Override for RESPONSE_HANDLER; also checks `OPENROUTER_SHOULD_RESPOND_MODEL`. |
| `OPENROUTER_ACTION_PLANNER_MODEL` | no | — | Override for ACTION_PLANNER; also checks `OPENROUTER_PLANNER_MODEL`. |
| `OPENROUTER_IMAGE_MODEL` | no | `x-ai/grok-2-vision-1212` | Override for IMAGE_DESCRIPTION. |
| `OPENROUTER_IMAGE_GENERATION_MODEL` | no | `google/gemini-2.5-flash-image-preview` | Override for IMAGE generation. |
| `OPENROUTER_EMBEDDING_MODEL` | no | `openai/text-embedding-3-small` | Override for TEXT_EMBEDDING. |
| `OPENROUTER_TRANSCRIPTION_MODEL` | no | `openai/whisper-large-v3` | Override for TRANSCRIPTION. |
| `OPENROUTER_EMBEDDING_DIMENSIONS` | no | `1536` | Embedding vector size. Valid: 256, 384, 512, 768, 1024, 1536, 2048, 3072. |
| `OPENROUTER_AUTO_CLEANUP_IMAGES` | no | `false` | Flag read by `shouldAutoCleanupImages()` in `utils/config.ts`. |
| `SMALL_MODEL`, `LARGE_MODEL`, etc. | no | — | Generic fallbacks when OPENROUTER_* variants are unset. |

`OPENROUTER_HTTP_REFERER` and `OPENROUTER_X_TITLE` are read in `embedding.ts` for the embeddings request headers.

## How to extend

**Add a new model handler type:**
1. Add a handler function in the appropriate `models/*.ts` file following the pattern of existing handlers (call `generateTextWithModel` with the new `ModelType`).
2. Register it in `plugin.ts` under `models: { [ModelType.NEW_TYPE]: async (runtime, params) => ... }`.
3. If the type needs a configurable model name, add `getNewTypeModel()` to `utils/config.ts` following the priority pattern: `OPENROUTER_*` first, generic fallback second, hard default third.

**Add a config helper:**
- Add to `utils/config.ts`. Follow the `getSetting(runtime, "OPENROUTER_X") ?? getSetting(runtime, "X", default)` pattern so agent character settings override env vars.

**Add a test:**
- Unit tests go in `__tests__/`. Live integration tests (real API) go in `__tests__/*.live.test.ts` and use `vitest.live.config.ts`.

## Conventions / gotchas

- **Sampling param suppression:** `models/text.ts:supportsSamplingParameters()` skips temperature/frequencyPenalty/presencePenalty for `openai/*`, `anthropic/*`, and reasoning models. Extend the constant arrays at the top of that file if new no-sampling models are added.
- **Browser build:** The browser export omits the API key from the `Authorization` header. Set `OPENROUTER_BROWSER_BASE_URL` to a server-side proxy that injects the key. The `init.ts` API key validation is also skipped in browser environments.
- **Embedding dimension validation:** The embedding handler validates the configured dimension against `VECTOR_DIMS` from `@elizaos/core`. Mismatches throw immediately — no silent truncation.
- **Embedding input truncation:** Inputs over ~32 000 characters (~8 000 tokens) are truncated with a warning rather than failing.
- **Structured output:** Pass `responseSchema` (JSON Schema object) to any text handler to get parsed JSON back. The handler wraps it into the AI SDK `output` field and calls `JSON.parse` on the response.
- **Prompt caching:** Pass `providerOptions: { openrouter: { promptCacheKey: "<key>" } }` to text handlers; it is forwarded to OpenRouter's `prompt_cache_key` for prefix caching on supported backends.
- **Audio transcription:** `ModelType.TRANSCRIPTION` posts base64 audio to OpenRouter's `/audio/transcriptions` endpoint. Supported inputs are URL strings, `Buffer`, `Blob` / `File`, core `{ audioUrl, prompt? }`, and local `{ audio, model?, language?, temperature?, format?, mimeType? }` objects.
- **`@openrouter/ai-sdk-provider` + `ai` SDK:** The plugin wraps `@openrouter/ai-sdk-provider ^2.0.0` and uses `ai ^6.0.30`. Both are runtime dependencies, not peer deps.
