# @elizaos/plugin-lmstudio

Provides local LLM inference for Eliza agents via LM Studio's OpenAI-compatible API.

## Purpose / role

This plugin wires LM Studio (a local model server at `http://localhost:1234/v1` by default) into the elizaOS model dispatch system. It registers model handlers for every text-generation tier and for embeddings. The plugin auto-enables when `LMSTUDIO_BASE_URL` is set **or** when the default endpoint responds to a `/v1/models` probe — no explicit plugin list entry is required in those cases. It is opt-in when neither condition is true.

## Plugin surface

This plugin registers **model handlers only** — no actions, providers, evaluators, services, routes, or events beyond `MODEL_USED` emissions.

| Model type | Handler |
|---|---|
| `ModelType.TEXT_NANO` | `handleTextNano` — maps small/nano calls to the small model tier |
| `ModelType.TEXT_SMALL` | `handleTextSmall` — primary small-tier handler |
| `ModelType.TEXT_MEDIUM` | `handleTextMedium` — maps medium calls to the small model tier |
| `ModelType.TEXT_LARGE` | `handleTextLarge` — primary large-tier handler |
| `ModelType.TEXT_MEGA` | `handleTextMega` — maps mega calls to the large model tier |
| `ModelType.RESPONSE_HANDLER` | `handleResponseHandler` — response generation |
| `ModelType.ACTION_PLANNER` | `handleActionPlanner` — action planning (routed to large model) |
| `ModelType.TEXT_EMBEDDING` | `handleTextEmbedding` — vector embeddings via `/v1/embeddings` |

All text handlers share `handleTextWithModelType` in `models/text.ts`, which supports streaming, structured output (`Output.object`), native tool calls, and per-tier model resolution. Embeddings fall back to a zero vector (length 1536) when `LMSTUDIO_EMBEDDING_MODEL` is not set, matching plugin-ollama behavior.

## Layout

```
plugins/plugin-lmstudio/
  plugin.ts              Plugin object — model handler wiring + init probe + autoEnable predicate
  index.ts               Package entry — re-exports plugin, types, and config/detect utilities
  index.node.ts          Node/Bun build entry
  index.browser.ts       Browser build entry
  auto-enable.ts         Lightweight manifest entry-point for the autoEnableModule check (env-only)
  build.ts               Bun.build script (node + browser + cjs bundles, then tsc declarations)
  models/
    text.ts              All text generation handlers; resolveModelForType; streaming + structured output
    embedding.ts         handleTextEmbedding via @ai-sdk/openai-compatible textEmbeddingModel
    index.ts             Re-exports all handlers
  utils/
    client.ts            createLMStudioClient — @ai-sdk/openai-compatible provider factory
    config.ts            getSetting, getBaseURL, getApiKey, getSmallModel, getLargeModel, getEmbeddingModel, shouldAutoDetect
    detect.ts            detectLMStudio — probes GET /v1/models; parseModelsResponse; DetectionResult
    model-usage.ts       normalizeTokenUsage, estimateUsage, estimateEmbeddingUsage, emitModelUsed (MODEL_USED event)
  types/
    index.ts             LMStudioConfig, LMStudioModelInfo, LMStudioModelsResponse
  __tests__/
    config.test.ts       Unit tests for config resolution
    detect.test.ts       Unit tests for detectLMStudio with deterministic fetch
    embedding.test.ts    Unit tests for handleTextEmbedding
    text.shape.test.ts   Unit tests for normalizeNativeTools, normalizeToolChoice, normalizeNativeMessages
    integration.test.ts  Integration tests (requires live LM Studio)
```

## Commands

These are the scripts available in this package:

```bash
bun run --cwd plugins/plugin-lmstudio build          # Bun.build via build.ts (node + browser + cjs) + tsc declarations
bun run --cwd plugins/plugin-lmstudio dev            # watch build
bun run --cwd plugins/plugin-lmstudio test           # unit tests (vitest)
bun run --cwd plugins/plugin-lmstudio test:unit      # same as test
bun run --cwd plugins/plugin-lmstudio lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-lmstudio lint:check     # biome check (read-only)
bun run --cwd plugins/plugin-lmstudio format         # biome format --write
bun run --cwd plugins/plugin-lmstudio format:check   # biome format (read-only)
bun run --cwd plugins/plugin-lmstudio typecheck      # tsc --noEmit --noCheck
bun run --cwd plugins/plugin-lmstudio clean          # rm -rf dist .turbo .turbo-tsconfig.json tsconfig.tsbuildinfo
```

## Config / env vars

All vars are optional. Resolution order: `runtime.getSetting(key)` → `process.env[key]` → default.

| Var | Default | Notes |
|---|---|---|
| `LMSTUDIO_BASE_URL` | `http://localhost:1234/v1` | Base URL; `/v1` is appended automatically if absent |
| `LMSTUDIO_API_KEY` | _(none)_ | Bearer token; LM Studio does not require one by default |
| `LMSTUDIO_SMALL_MODEL` | _(auto)_ | Model id for small/nano/medium tiers; falls back to `SMALL_MODEL` then first `/v1/models` entry |
| `LMSTUDIO_LARGE_MODEL` | _(auto)_ | Model id for large/mega/action-planner tiers; falls back to `LARGE_MODEL` then first `/v1/models` entry |
| `LMSTUDIO_EMBEDDING_MODEL` | _(none)_ | Model id for embeddings; zero vector returned if unset |
| `LMSTUDIO_AUTO_DETECT` | `true` | Set to `0`/`false` to skip the init-time `/v1/models` probe |

## How to extend

**Add a new model handler:**
1. Add the handler function in `models/text.ts` (or a new file under `models/`), calling `handleTextWithModelType` with the desired `ModelTypeName`.
2. Export it from `models/index.ts`.
3. Register it in the `models` map in `plugin.ts`.

**Add a new utility:**
- Place it in `utils/` as a named export. Import from there; do not put utility logic directly in `plugin.ts`.

**Add config vars:**
- Add resolution in `utils/config.ts` (follow the `getSetting` pattern).
- Add the var to `agentConfig.pluginParameters` in `package.json` so the runtime surfaces it.

## Conventions / gotchas

- **Model resolution is cached per runtime instance.** The first call to `GET /v1/models` is stored in a `WeakMap<IAgentRuntime, Promise<string | null>>`. Tests that use multiple runtimes are unaffected; tests that reuse the same runtime instance will see cached results.
- **Streaming + structured output are mutually exclusive.** When `stream: true` is set alongside a `responseSchema`, `handleTextWithModelType` keeps the structured output and routes through `generateText` instead of streaming, to avoid LM Studio model engine inconsistencies. (Note: if both `tools` and `responseSchema` are present, the structured output is dropped instead — see the `tools && outputSpec` branch.)
- **Embeddings do not throw on missing model.** When `LMSTUDIO_EMBEDDING_MODEL` is unset, a zero vector is returned. This matches plugin-ollama but means embedding quality silently degrades — always set this var when using memory/recall features.
- **Browser build is available** (`dist/browser/index.browser.js`) but LM Studio itself is a local desktop app; browser use only makes sense when LM Studio is behind a CORS-permissive reverse proxy.
- **Dependencies:** `@ai-sdk/openai-compatible` (provider factory) and `ai` (Vercel AI SDK core — `generateText`, `streamText`, `embed`, `Output`). Both are runtime deps; `@elizaos/core` is a peer dep.
- **No actions/providers/services.** If you need an action that calls a local model, implement it in the agent layer using `runtime.generateText` — the plugin just wires the transport.
- See `/AGENTS.md` (repo root) for repo-wide architecture rules, logger conventions, and git workflow.
