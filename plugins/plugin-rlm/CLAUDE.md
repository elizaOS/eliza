# @elizaos/plugin-rlm

RLM (Recursive Language Model) adapter — enables Eliza agents to process arbitrarily long contexts via recursive self-calls.

## Purpose / role

This plugin integrates the Recursive Language Model technique (arXiv:2512.24601) into elizaOS. It registers model handlers so that any call to `runtime.useModel(ModelType.TEXT_LARGE, ...)` (and related model types) is routed through an RLM backend, which processes long inputs by spawning a Python subprocess and communicating over JSON-RPC IPC. When the Python backend is absent, model calls fail explicitly instead of returning fallback text. The plugin is opt-in: add `@elizaos/plugin-rlm` to your character's plugin list to enable it.

## Plugin surface

Registers **model handlers** only — no actions, providers, evaluators, services, routes, or events.

| Model type | Handler |
|---|---|
| `ModelType.TEXT_SMALL` | `handleTextGeneration` |
| `ModelType.TEXT_LARGE` | `handleTextGeneration` |
| `ModelType.TEXT_REASONING_SMALL` | `handleTextGeneration` |
| `ModelType.TEXT_REASONING_LARGE` | `handleTextGeneration` |
| `ModelType.TEXT_COMPLETION` | `handleTextGeneration` |

All five model types funnel into the same `handleTextGeneration` function in `index.ts`, which delegates to `RLMClient.infer()`.

## Layout

```
plugins/plugin-rlm/
├── index.ts                  # Plugin definition (rlmPlugin), singleton client management,
│                             # handleTextGeneration, resetClient()
├── client.ts                 # RLMClient class — spawns Python subprocess, JSON-RPC IPC,
│                             # retry logic, metrics; configFromEnv()
├── server.ts                 # RLMServer class — TCP-based IPC server wrapping RLMClient
│                             # (used when the TS side acts as server, not subprocess caller)
├── cost.ts                   # estimateCost(), estimateTokenCount(), detectStrategy(),
│                             # MODEL_PRICING table, ELIZA_RLM_PRICING_JSON override
├── types.ts                  # All shared types: RLMConfig, RLMResult, RLMInferOptions,
│                             # ENV_VARS, DEFAULT_CONFIG, validateConfig()
├── trajectory-integration.ts # RLMTrajectoryIntegration class — wraps RLMClient with
│                             # step-level cost tracking and optional trajectory logger hook;
│                             # inferWithLogging() convenience function
└── __tests__/
    ├── plugin.test.ts
    ├── integration.test.ts
    ├── cost.test.ts
    ├── server.test.ts
    └── trajectory-integration.test.ts
```

## Commands

Only scripts defined in `package.json`:

```bash
bun run --cwd plugins/plugin-rlm build          # tsup — emit dist/
bun run --cwd plugins/plugin-rlm dev            # tsup --watch
bun run --cwd plugins/plugin-rlm test           # vitest run
bun run --cwd plugins/plugin-rlm test:watch     # vitest (interactive)
bun run --cwd plugins/plugin-rlm typecheck      # tsgo --noEmit
bun run --cwd plugins/plugin-rlm lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-rlm lint:check     # biome check (read-only)
bun run --cwd plugins/plugin-rlm format         # biome format --write
bun run --cwd plugins/plugin-rlm format:check   # biome format (read-only)
```

## Config / env vars

Most vars are defined in `types.ts` (`ENV_VARS` const) and consumed in `index.ts` init and `client.ts` `configFromEnv()`. Exception: `ELIZA_RLM_PRICING_JSON` is read directly in `cost.ts` and is not in `ENV_VARS`.

| Env var | Default | Description |
|---|---|---|
| `ELIZA_RLM_BACKEND` | `gemini` | LLM backend for the Python RLM layer: `openai`, `anthropic`, `gemini`, `groq`, `openrouter` |
| `ELIZA_RLM_ENV` | `local` | Execution environment: `local`, `docker`, `modal`, `prime` |
| `ELIZA_RLM_MAX_ITERATIONS` | `4` | Maximum REPL iterations per inference call |
| `ELIZA_RLM_MAX_DEPTH` | `1` | Maximum recursion depth |
| `ELIZA_RLM_VERBOSE` | `false` | Enable verbose logging in the Python subprocess |
| `ELIZA_RLM_PYTHON_PATH` | `python` | Path to the Python executable |
| `ELIZA_RLM_MAX_RETRIES` | `3` | Retry attempts for transient errors |
| `ELIZA_RLM_RETRY_BASE_DELAY` | `1000` | Base retry delay in ms (exponential backoff) |
| `ELIZA_RLM_RETRY_MAX_DELAY` | `30000` | Max retry delay in ms |
| `ELIZA_RLM_PRICING_JSON` | _(unset)_ | JSON override for MODEL_PRICING (backend→model→{input,output} per 1M tokens) |

Backend API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, etc.) are forwarded to the Python subprocess via `process.env` — the plugin does not read them directly.

None of the env vars are strictly required for plugin initialization. Real inference requires the Python backend; if it is unavailable, `RLMClient.infer()` throws and `getStatus()` reports `available: false`.

## How to extend

**Add a new model type handler:**
1. Import the new `ModelType` variant from `@elizaos/core`.
2. Add `[ModelType.NEW_TYPE]: handleTextGeneration` in the `models` block of `rlmPlugin` in `index.ts`.

**Add per-request inference options:**
1. Add the new field to `RLMInferOptions` in `types.ts`.
2. Pass it through `handleTextGeneration` → `client.infer()` → the IPC `params` object.

**Add a new metric or cost entry:**
1. For pricing, add entries to `MODEL_PRICING` in `cost.ts` under the relevant backend key.
2. For metrics fields, extend `RLMMetrics` in `types.ts` and update `updateMetrics()` in `client.ts`.

**Integrate trajectory logging:**
Use `RLMTrajectoryIntegration` from `trajectory-integration.ts`. It accepts an optional `TrajectoryLogger` interface (compatible with `plugin-trajectory-logger`) and wraps `RLMClient.infer()` with step-level cost tracking.

## Conventions / gotchas

- **Singleton client:** `index.ts` keeps a module-level singleton `clientState`. Config changes (detected by hash) trigger a shutdown + recreation. Call `resetClient()` (exported) to force teardown in tests.
- **No fallback inference:** When the Python subprocess fails to start, `RLMClient.infer()` throws. Use `getStatus()` for diagnostics before routing traffic through RLM.
- **Python subprocess path:** The subprocess is spawned relative to `__dirname/../python`. The Python package must be installed as `elizaos_plugin_rlm` (i.e. `pip install git+https://github.com/alexzhang13/rlm.git` followed by packaging it under that module name, or use the provided server shim).
- **`assertRecordedLlmCall` enforcement:** `RLMClient.infer()` calls `assertRecordedLlmCall` from `@elizaos/core` at entry, requiring that all calls go through `recordLlmCall()`. The plugin's `handleTextGeneration` satisfies this by wrapping the client call in `recordLlmCall`. If you call `RLMClient.infer()` directly outside a `recordLlmCall` context it will throw.
- **No streaming:** The RLM adapter returns complete text responses; all model type handlers return `Promise<string>`.
- **Token counting:** Uses a naive `text.length / 4` approximation — matches the Python fallback but is inaccurate for non-ASCII content.
- **Node-only:** `"eliza".platforms: ["node"]`. Not usable in browser or mobile runtimes.
- See root `AGENTS.md` for repo-wide conventions (logger usage, ESM, naming, architecture rules).
