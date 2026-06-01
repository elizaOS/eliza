# @elizaos/plugin-zai

z.ai model provider plugin for elizaOS — registers `TEXT_SMALL` and `TEXT_LARGE` model handlers backed by z.ai's OpenAI-compatible API.

## Purpose / role

Enables Eliza agents to use z.ai language models (`glm-4.5-air` and `glm-5.1` by default) for text generation. The plugin is auto-enabled when `ZAI_API_KEY` (or the legacy `Z_AI_API_KEY`) is present in the environment. It registers no actions, providers, evaluators, or routes — only model handlers. Supports both Node.js and browser runtimes (browser build uses a proxy base URL instead of the API key directly).

## Plugin surface

No actions, evaluators, providers, or routes are registered.

**Model handlers** (registered on `Plugin.models`):
- `ModelType.TEXT_SMALL` — handled by `handleTextSmall`; uses the `ZAI_SMALL_MODEL` identifier (default `glm-4.5-air`).
- `ModelType.TEXT_LARGE` — handled by `handleTextLarge`; uses the `ZAI_LARGE_MODEL` identifier (default `glm-5.1`).

Both handlers emit `EventType.MODEL_USED` via `emitModelUsageEvent` after each call, carrying prompt/completion/total token counts sourced from the Vercel AI SDK response.

**Auto-enable** (`auto-enable.ts`): elizaOS calls `shouldEnable({ env })` at boot; the plugin self-activates when `ZAI_API_KEY` or `Z_AI_API_KEY` is non-empty. No explicit plugin registration is required when either key is set.

## Layout

```
plugins/plugin-zai/
  index.ts                  Plugin definition (zaiPlugin), config snapshot, test suites
  index.node.ts             Node entrypoint — re-exports index.ts (dist/node/index.node.js)
  index.browser.ts          Browser entrypoint (dist/browser/index.browser.js)
  auto-enable.ts            shouldEnable() — env-only check; no plugin runtime imports
  init.ts                   initializeZai() — validates API key presence at startup
  models/
    index.ts                Re-exports handleTextSmall, handleTextLarge
    text.ts                 Core text generation: resolveTextParams, generateTextWithModel
  providers/
    index.ts                Re-exports createZaiClient, ZaiProvider, ZaiFetch
    openai-compatible.ts    createZaiClient() — builds @ai-sdk/openai-compatible instance
  types/
    index.ts                Branded types: ValidatedApiKey, ModelName, ModelSize, ProviderOptions
  utils/
    config.ts               All setting/env reads: getApiKey, getBaseURL, getSmallModel,
                            getLargeModel, getThinkingConfig, getCoTBudget, etc.
    events.ts               emitModelUsageEvent() — wraps runtime.emitEvent(MODEL_USED, ...)
  __tests__/                Unit tests (vitest)
  build.ts                  Build script (node ESM + browser + CJS via Bun.build; tsc for declarations)
```

## Commands

Only scripts that exist in `package.json`:

```bash
bun run --cwd plugins/plugin-zai build          # compile node + browser outputs to dist/
bun run --cwd plugins/plugin-zai dev            # watch mode build
bun run --cwd plugins/plugin-zai test           # vitest run
bun run --cwd plugins/plugin-zai test:watch     # vitest watch
bun run --cwd plugins/plugin-zai typecheck      # tsgo --noEmit
bun run --cwd plugins/plugin-zai lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-zai lint:check     # biome check (read-only)
bun run --cwd plugins/plugin-zai format         # biome format --write
bun run --cwd plugins/plugin-zai format:check   # biome format (read-only)
bun run --cwd plugins/plugin-zai clean          # rm dist/ .turbo/
```

## Config / env vars

All values are read via `runtime.getSetting(key)` first, then `process.env[key]`.

| Var | Required | Default | Notes |
|---|---|---|---|
| `ZAI_API_KEY` | Yes (Node) | — | Primary API key. Not required in browser builds. |
| `Z_AI_API_KEY` | No | — | Legacy alias; accepted when `ZAI_API_KEY` is absent. |
| `ZAI_BASE_URL` | No | `https://api.z.ai/api/paas/v4` | General API only. `/api/coding/` and `/api/anthropic` paths are actively blocked. |
| `ZAI_BROWSER_BASE_URL` | No | — | Browser-only proxy URL. Replaces `ZAI_BASE_URL` in browser runtime. |
| `ZAI_SMALL_MODEL` | No | `glm-4.5-air` | Model ID for `TEXT_SMALL`. |
| `ZAI_LARGE_MODEL` | No | `glm-5.1` | Model ID for `TEXT_LARGE`. |
| `ZAI_THINKING_TYPE` | No | — | `"enabled"` or `"disabled"`; overrides z.ai's default thinking behavior. |
| `ZAI_COT_BUDGET` | No | — | Deprecated. Positive value enables thinking mode (Anthropic `budget_tokens` is NOT sent). |
| `ZAI_COT_BUDGET_SMALL` | No | — | Deprecated per-size override of `ZAI_COT_BUDGET` for small models. |
| `ZAI_COT_BUDGET_LARGE` | No | — | Deprecated per-size override of `ZAI_COT_BUDGET` for large models. |
| `ZAI_EXPERIMENTAL_TELEMETRY` | No | `false` | Set `"true"` to enable Vercel AI SDK `experimental_telemetry`. |

## How to extend

**Add a model handler** (e.g., `TEXT_EMBEDDING`):
1. Implement the handler in `models/` (create a new file or add to `text.ts`).
2. Export it from `models/index.ts`.
3. Register it in `index.ts` under the `Plugin.models` key using the appropriate `ModelType` constant.

**Add an action or evaluator:**
1. Create the file in a new `actions/` or `evaluators/` subdirectory.
2. Add the object to `Plugin.actions` or `Plugin.evaluators` array in `index.ts`.
3. See root `AGENTS.md` for elizaOS action/evaluator conventions.

**Thinking mode** is injected at the HTTP fetch layer (`createZaiRequestFetch` in `models/text.ts`) rather than via an AI SDK parameter, because z.ai's OpenAI-compatible endpoint expects a `thinking` body field that the SDK does not natively produce. Keep that approach when adding new model types that need thinking support.

## Conventions / gotchas

- **No direct Anthropic `budget_tokens`.** `ZAI_COT_BUDGET*` vars are deprecated shims; they enable `ZAI_THINKING_TYPE=enabled` behavior, but the actual Anthropic field is never forwarded. Use `ZAI_THINKING_TYPE` instead.
- **Base URL validation is strict.** `normalizeDirectApiBaseURL` throws if the URL contains `/api/coding/` or `/api/anthropic`. Do not point this plugin at z.ai Coding Plan endpoints.
- **Browser build omits the API key.** In browsers, use `ZAI_BROWSER_BASE_URL` to route through a proxy that holds the key server-side.
- **`air`/`flash` models cap at 4096 max tokens** by default; all other models cap at 8192. This is hardcoded in `resolveTextParams`.
- **`glm-4.5-air`** is the default small model; **`glm-5.1`** is the default large model. Both can be overridden per-runtime via settings.
- `AI_SDK_LOG_WARNINGS` is silenced globally at plugin init to suppress Vercel AI SDK noise; this fires once at startup regardless of whether a key is present.
- For architecture conventions (logger-only logging, ESM module rules, layer boundaries), see the root `AGENTS.md`.
