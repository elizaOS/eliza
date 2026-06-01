# @elizaos/plugin-nearai

NEAR AI Cloud TEE inference provider for Eliza agents via an OpenAI-compatible API.

## Purpose / role

Registers `TEXT_SMALL` and `TEXT_LARGE` model handlers so any Eliza agent can route
text-generation requests through the NEAR AI Cloud inference API
(`https://cloud-api.near.ai/v1` by default). The plugin is **off by default** and
auto-enables when `NEARAI_API_KEY` is present in the environment (`shouldEnable()` in
`auto-enable.ts`, referenced via `elizaos.plugin.autoEnableModule` in `package.json`).
It ships dual builds for both Node.js and browser environments.

## Plugin surface

This plugin registers **no actions, providers, evaluators, or routes**. It registers only
model handlers:

| Model type | Handler | Default model |
|---|---|---|
| `ModelType.TEXT_SMALL` | `handleTextSmall` | `Qwen/Qwen3.6-35B-A3B-FP8` |
| `ModelType.TEXT_LARGE` | `handleTextLarge` | `zai-org/GLM-5.1-FP8` |

Both handlers emit a `EventType.MODEL_USED` event after each successful inference call
(token counts included).

## Layout

```
plugins/plugin-nearai/
  index.ts                  Plugin object (nearaiPlugin), test suites, env bootstrap
  index.node.ts             Node entry point (re-exports index.ts)
  index.browser.ts          Browser entry point (re-exports index.ts)
  auto-enable.ts            shouldEnable() — checks NEARAI_API_KEY; no side effects
  init.ts                   initializeNearAI() — warns if key missing on Node
  models/
    text.ts                 handleTextSmall / handleTextLarge; request normalisation
                            (maps max_completion_tokens→max_tokens, strips store/
                            reasoning_effort/strict, rewrites 'developer' role→'system')
    index.ts                Re-exports from text.ts
  providers/
    openai-compatible.ts    createNearAIClient() — wraps @ai-sdk/openai-compatible
    index.ts                Re-exports from openai-compatible.ts
  types/
    index.ts                Branded types: ValidatedApiKey, ModelName, ProviderOptions
  utils/
    config.ts               All runtime setting / env reads (getApiKey, getBaseURL,
                            getSmallModel, getLargeModel, getExperimentalTelemetry,
                            isBrowser, getRawSetting)
    events.ts               emitModelUsageEvent() helper
```

## Commands

```bash
bun run --cwd plugins/plugin-nearai build         # compile dist/
bun run --cwd plugins/plugin-nearai dev           # watch build
bun run --cwd plugins/plugin-nearai test          # vitest run
bun run --cwd plugins/plugin-nearai test:watch    # vitest watch
bun run --cwd plugins/plugin-nearai lint          # biome check --write --unsafe
bun run --cwd plugins/plugin-nearai typecheck     # tsgo --noEmit -p tsconfig.json
bun run --cwd plugins/plugin-nearai clean         # rm -rf dist .turbo + tsbuildinfo
```

## Config / env vars

All settings are read via `runtime.getSetting(key)` first, then `process.env[key]`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `NEARAI_API_KEY` | Yes (Node) | — | Authentication token for NEAR AI Cloud |
| `NEARAI_BASE_URL` | No | `https://cloud-api.near.ai/v1` | OpenAI-compatible API base URL (Node) |
| `NEARAI_BROWSER_BASE_URL` | No | — | Proxy URL used in browser builds instead of base URL (do not expose API keys in-browser) |
| `NEARAI_SMALL_MODEL` | No | `Qwen/Qwen3.6-35B-A3B-FP8` | Model identifier for `TEXT_SMALL` |
| `NEARAI_LARGE_MODEL` | No | `zai-org/GLM-5.1-FP8` | Model identifier for `TEXT_LARGE` |
| `NEARAI_EXPERIMENTAL_TELEMETRY` | No | `false` | Set `"true"` to enable Vercel AI SDK telemetry |

Model identifiers must match the NEAR AI catalog: `GET https://cloud-api.near.ai/v1/model/list`.

## How to extend

**Add a new model type** (e.g. `TEXT_EMBEDDING`):

1. Add a handler function in `models/text.ts` following the `generateTextWithModel` pattern.
2. Export it from `models/index.ts`.
3. Register it in the `models` map in `index.ts` under the appropriate `ModelType` key.
4. Add any new config keys to `utils/config.ts` (read via `getRawSetting`) and to `agentConfig.pluginParameters` in `package.json`.
5. Export the new env var from `PluginConfig` in `init.ts` and add it to `plugin.config` in `index.ts`.

**Add a provider option** (e.g. pass `agentName` through):

- `ProviderOptions` in `types/index.ts` is the extension point for nearai-specific request fields.
- `resolveTextParams` in `models/text.ts` reads `params.providerOptions.nearai` and maps to `ProviderOptions`.

## Conventions / gotchas

- **Request normalisation:** The NEAR AI API does not accept `max_completion_tokens`,
  `store`, `reasoning_effort`, or `strict` fields, and does not support the `developer`
  message role. `createNearAIRequestFetch` in `models/text.ts` strips/rewrites these
  before each request. Update it if the upstream API changes.
- **Browser builds:** `isBrowser()` guards all `process.env` access. In browser context,
  `NEARAI_BROWSER_BASE_URL` is used instead of `NEARAI_BASE_URL`; the API key is
  expected to be absent (requests go through a proxy).
- **Auto-enable:** `shouldEnable()` in `auto-enable.ts` is intentionally side-effect-free.
  Do not import the full plugin runtime from it.
- **Branded types:** `ValidatedApiKey` and `ModelName` are nominal string brands (`& { readonly __brand: ... }`). Use `assertValidApiKey` / `createModelName` to construct them — do not cast.
- **Telemetry:** `NEARAI_EXPERIMENTAL_TELEMETRY=true` enables the Vercel AI SDK's
  `experimental_telemetry` option. The `agentName` provider option surfaces in telemetry
  as `functionId` and metadata.
- **elizaOS core version:** peer-depends on `@elizaos/core` via `workspace:*`.
