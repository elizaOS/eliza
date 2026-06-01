# @elizaos/plugin-google-genai

Google Generative AI (Gemini) model provider for elizaOS agents.

## Purpose / role

Registers model handlers for all elizaOS `ModelType` tiers (nano through mega, plus embedding, image description, response handler, and action planner) backed by the Google Generative AI (Gemini) API. Loaded via the elizaOS plugin system; auto-enabled whenever `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, or `GEMINI_API_KEY` is present in the environment. No actions, providers, evaluators, or routes are registered — this plugin's entire surface is model handlers.

## Plugin surface

| Model type | Handler | Default model |
|---|---|---|
| `TEXT_NANO` | `handleTextNano` | falls back to small model |
| `TEXT_SMALL` | `handleTextSmall` | `gemini-2.0-flash-001` |
| `TEXT_MEDIUM` | `handleTextMedium` | falls back to small model |
| `TEXT_LARGE` | `handleTextLarge` | `gemini-2.5-pro-preview-03-25` |
| `TEXT_MEGA` | `handleTextMega` | falls back to large model |
| `RESPONSE_HANDLER` | `handleResponseHandler` | falls back to nano model |
| `ACTION_PLANNER` | `handleActionPlanner` | falls back to medium model |
| `TEXT_EMBEDDING` | `handleTextEmbedding` | `text-embedding-004` (768-dim) |
| `IMAGE_DESCRIPTION` | `handleImageDescription` | `gemini-2.5-pro-preview-03-25` |

Event emitted after each model call: `MODEL_USED` (via `runtime.emitEvent`).

## Layout

```
plugins/plugin-google-genai/
  index.ts                  Plugin object (googleGenAIPlugin), model handler wiring, built-in TestSuites
  index.node.ts             Node/Bun entry (re-exports index.ts)
  index.browser.ts          Browser entry (re-exports index.ts)
  init.ts                   initializeGoogleGenAI() — validates API key at startup
  auto-enable.ts            shouldEnable() — checked by elizaOS auto-enable engine at boot
  models/
    index.ts                Re-exports all handlers
    text.ts                 handleTextSmall/Large/Nano/Medium/Mega/ResponseHandler/ActionPlanner
    embedding.ts            handleTextEmbedding
    image.ts                handleImageDescription
  utils/
    config.ts               getApiKey, createGoogleGenAI, get*Model helpers, getSafetySettings
    events.ts               emitModelUsageEvent (wraps runtime.emitEvent)
    tokenization.ts         countTokens (char-length heuristic, not a real tokenizer)
  types/
    index.ts                Local TS interfaces: TokenUsage, TextGenerationResponse, ImageDescriptionResponse, etc.
  generated/                (generated code — do not hand-edit)
```

## Commands

Scripts that exist in `package.json`:

```bash
bun run --cwd plugins/plugin-google-genai build          # tsdown build (node + browser bundles)
bun run --cwd plugins/plugin-google-genai dev            # build --watch
bun run --cwd plugins/plugin-google-genai typecheck      # tsgo --noEmit
bun run --cwd plugins/plugin-google-genai test           # vitest run (all tests)
bun run --cwd plugins/plugin-google-genai test:unit      # vitest run --dir __tests__/unit
bun run --cwd plugins/plugin-google-genai test:integration  # vitest run --dir __tests__/integration
bun run --cwd plugins/plugin-google-genai lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-google-genai format         # biome format --write
bun run --cwd plugins/plugin-google-genai clean          # rm -rf dist .turbo
```

## Config / env vars

Settings are read first from `runtime.getSetting(key)`, then from `process.env`. All model settings accept both a `GOOGLE_*` prefix (plugin-specific) and a bare generic name (fallback).

| Env var | Required | Default | Notes |
|---|---|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | Yes | — | Also accepted: `GOOGLE_API_KEY`, `GEMINI_API_KEY` (auto-enable only) |
| `GOOGLE_NANO_MODEL` / `NANO_MODEL` | No | falls back to small | |
| `GOOGLE_SMALL_MODEL` / `SMALL_MODEL` | No | `gemini-2.0-flash-001` | |
| `GOOGLE_MEDIUM_MODEL` / `MEDIUM_MODEL` | No | falls back to small | |
| `GOOGLE_LARGE_MODEL` / `LARGE_MODEL` | No | `gemini-2.5-pro-preview-03-25` | |
| `GOOGLE_MEGA_MODEL` / `MEGA_MODEL` | No | falls back to large | |
| `GOOGLE_RESPONSE_HANDLER_MODEL` / `GOOGLE_SHOULD_RESPOND_MODEL` | No | falls back to nano | |
| `GOOGLE_ACTION_PLANNER_MODEL` / `GOOGLE_PLANNER_MODEL` | No | falls back to medium | |
| `GOOGLE_IMAGE_MODEL` / `IMAGE_MODEL` | No | `gemini-2.5-pro-preview-03-25` | |
| `GOOGLE_EMBEDDING_MODEL` | No | `text-embedding-004` | 768-dimension output |

## How to extend

### Add a new model handler

1. Add the handler function to `models/text.ts` (or a new file under `models/`) following the pattern of `handleTextWithType`.
2. Export it from `models/index.ts`.
3. Wire it into the `models` map in `index.ts` using the appropriate `ModelType` constant.
4. Add a model-name resolver in `utils/config.ts` (a `get*Model` helper that reads `runtime.getSetting` then `process.env`).
5. Add the new env var keys to the `config` map in the `googleGenAIPlugin` object in `index.ts`.

### Add a test case

Append a `TestCase` object to the `pluginTests[0].tests` array in `index.ts`. Tests run via `runtime.useModel(...)` and assert on the result shape.

## Conventions / gotchas

- **Dual build targets.** `exports.browser` and `exports.node` point to different bundles (`dist/browser/` vs `dist/node/`). The browser build must not import Node-only globals; `utils/config.ts` guards `typeof process` for this reason.
- **Auto-enable module is import-cost sensitive.** `auto-enable.ts` must stay small — no imports of the full plugin runtime. The elizaOS boot loader executes it for every plugin candidate.
- **Structured output.** Pass a JSON Schema as `responseSchema` in `GenerateTextParams`. Text handlers internally set `responseMimeType: "application/json"` and `responseJsonSchema` on the Google SDK request. The model returns raw JSON text; no post-parse step is applied for text handlers (the caller owns parsing).
- **Safety settings are hardcoded.** All four harm categories block at `BLOCK_MEDIUM_AND_ABOVE`. Adjust in `utils/config.ts → getSafetySettings()` if needed.
- **Token counting is a heuristic.** `utils/tokenization.ts` estimates tokens as `Math.ceil(text.length / 4)`. It is used for telemetry only; do not rely on it for context-window management.
- **Embedding truncation.** Inputs longer than ~32 768 characters (~8 192 tokens) are truncated before being sent to the embedding model.
- **No actions, providers, or evaluators.** If you need to add behavior beyond model inference, register it in a separate plugin or in the agent's character definition.
