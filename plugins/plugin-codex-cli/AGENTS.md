# @elizaos/plugin-codex-cli

ChatGPT Codex model provider plugin for elizaOS — routes text generation through a user's ChatGPT Plus/Pro subscription using the OAuth token cache written by the official `codex` CLI.

## Purpose / role

This plugin registers model handlers so Eliza agents can use ChatGPT Codex models (`gpt-5`, `gpt-5.5`, etc.) as their inference backend. It is **not** auto-enabled by an env var; it activates when an auth profile in the runtime config sets `provider: "codex-cli"`, or when `agents.defaults.subscriptionProvider` is `"openai-codex"`. It is node-only (`"platforms": ["node"]`).

## Plugin surface

No actions, providers, evaluators, or routes are registered. The plugin registers **model handlers only**:

| Model type registered | What it does |
|---|---|
| `TEXT_SMALL` | Codex-backed small text generation |
| `TEXT_NANO` | Codex-backed nano text generation |
| `TEXT_MEDIUM` | Codex-backed medium text generation |
| `TEXT_LARGE` | Codex-backed large text generation |
| `TEXT_MEGA` | Codex-backed mega text generation |
| `RESPONSE_HANDLER` | Codex-backed response handler model |
| `ACTION_PLANNER` | Codex-backed action planner model |

All model types delegate to `generateTextWithCodex()` in `index.ts`, which calls `CodexBackend.generate()`. Streaming is supported via `TextStreamResult`.

## Layout

```
plugins/plugin-codex-cli/
  index.ts                  Plugin entry point — registers model handlers, exports Plugin object
  index.node.ts             Node build re-export (re-exports index.ts default)
  index.browser.ts          Browser stub (no-op; plugin is node-only)
  auto-enable.ts            Auto-enable module (shouldEnable + shouldForce); referenced by package.json elizaos.plugin.autoEnableModule
  src/
    codex-backend.ts        CodexBackend class — HTTP client for ChatGPT Codex /responses SSE endpoint; FIFO queue + jitter
    codex-auth.ts           OAuth token load/save/refresh with file-level lock; isExpired() JWT check
    sse-parser.ts           Spec-compliant SSE AsyncGenerator parser for ReadableStream<Uint8Array>
    tool-format-openai.ts   toOpenAITool() / toOpenAITools() — maps elizaOS ToolDefinition to OpenAI function tool shape
  __tests__/
    codex-backend.test.ts   Unit tests for CodexBackend, message translation, and auth
  build.ts                  Bun.build script (node + browser bundles via Bun bundler; declarations via tsc)
  vitest.config.ts          Test config
```

## Commands

All commands run from the plugin directory:

```bash
bun run --cwd plugins/plugin-codex-cli build        # compile (Bun.build + tsc for declarations)
bun run --cwd plugins/plugin-codex-cli dev          # watch build
bun run --cwd plugins/plugin-codex-cli test         # vitest run
bun run --cwd plugins/plugin-codex-cli lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-codex-cli lint:check   # biome check (no write)
bun run --cwd plugins/plugin-codex-cli format       # biome format --write
bun run --cwd plugins/plugin-codex-cli typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-codex-cli clean        # rm -rf dist .turbo
```

## Config / env vars

| Var | Required | Default | Description |
|---|---|---|---|
| `CODEX_AUTH_PATH` | No | `~/.codex/auth.json` | Path to codex CLI OAuth cache file |
| `CODEX_BASE_URL` | No | `https://chatgpt.com/backend-api/codex` | Codex backend base URL; only `chatgpt.com` or `localhost` accepted |
| `CODEX_MODEL` | No | `gpt-5.5` | Model identifier; must be one of the supported models |
| `CODEX_JITTER_MS_MAX` | No | `200` | Max pre-request jitter in ms; set `0` to disable |
| `CODEX_ORIGINATOR` | No | `codex_cli_rs` | Originator header sent to the backend |
| `CODEX_USER_AGENT` | No | `codex_cli_rs/0.124.0` | User-Agent header (env only; not in agentConfig) |

Settings are read via `runtime.getSetting()` first, falling back to `process.env`. None are required; the plugin will fail at request time if `CODEX_AUTH_PATH` is missing or the auth file is absent/expired with no valid refresh token.

No auto-enable env var trigger exists. Auto-enable logic lives in `auto-enable.ts`:
- `shouldEnable`: any auth profile has `provider === "codex-cli"`.
- `shouldForce`: `agents.defaults.subscriptionProvider === "openai-codex"`.

## How to extend

**Add a new model type handler:**
1. Import the new `ModelType` constant from `@elizaos/core` in `index.ts`.
2. Add an entry to the `codexModels` object following the existing pattern: `[ModelType.NEW_TYPE]: (runtime, params) => generateTextWithCodex(runtime, params, ModelType.NEW_TYPE)`.
3. Declare it in `package.json` under `elizaos.plugin.capabilities` if appropriate.

**Swap the backend or auth mechanism:**
- `CodexBackend` accepts `loadAuth`, `refreshAuth`, `fetchImpl`, and `toolTranslator` overrides in its constructor config — use these in tests and when integrating alternate auth flows.

**Add a provider or action:**
- This plugin intentionally has no actions or providers. Adding one follows the standard elizaOS pattern: define it, add it to the `Plugin` object's `actions` or `providers` array in `index.ts`.

## Conventions / gotchas

- **Node-only.** The browser export (`index.browser.ts`) exists to satisfy the build; the plugin will not function in a browser runtime. The `src/codex-auth.ts` module uses `node:fs`, `node:crypto`, and `node:os`.
- **Single in-flight FIFO queue.** `CodexBackend` chains requests via `this.tail` promise — all calls on the same backend instance serialize. One `CodexBackend` instance per runtime is maintained via `backendByRuntime` WeakMap in `index.ts`.
- **Base URL validation.** `CODEX_BASE_URL` must target `https://chatgpt.com` or `localhost`; any other host throws at backend construction to prevent OAuth token exfiltration.
- **401 auto-refresh.** On a 401 from the Responses endpoint, the backend refreshes the OAuth token (with a file lock) and retries exactly once.
- **Tool calls return an object, not a string.** When `params.tools` is non-empty, `params.messages` is provided, or the backend returns tool calls, `generateTextWithCodex` returns `TextResultWithNativeTools` (`{ text, toolCalls, finishReason, usage }`) rather than a plain string.
- **`responseSchema` support.** When callers pass a `responseSchema` and no explicit `responseFormat`, the backend wraps it in `{ type: "json_schema", schema }` for the OpenAI Responses API structured output format.
- **Auth file lock.** `codex-auth.ts` uses a `.lock` file alongside `auth.json` (30 s stale timeout, 30 retries at 100 ms). Stale locks are cleaned up automatically.
- **Supported models:** `gpt-5`, `gpt-5-codex`, `gpt-5.4`, `gpt-5.5`, `gpt-5.5-pro`. Setting `CODEX_MODEL` to anything else will be sent as-is; the backend may reject it.
- See the root `AGENTS.md` for repo-wide architecture rules, logger conventions, and ESM requirements.
