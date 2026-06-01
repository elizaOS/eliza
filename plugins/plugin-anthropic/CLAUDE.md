# @elizaos/plugin-anthropic

Anthropic Claude model provider for elizaOS — registers model handlers for text generation, reasoning, image description, and structured output across all elizaOS `ModelType` tiers.

## Purpose / role

This plugin wires Anthropic Claude models into the elizaOS model dispatch layer. When loaded, it handles every `runtime.useModel()` call for `TEXT_NANO`, `TEXT_SMALL`, `TEXT_MEDIUM`, `TEXT_LARGE`, `TEXT_MEGA`, `TEXT_REASONING_SMALL`, `TEXT_REASONING_LARGE`, `RESPONSE_HANDLER`, `ACTION_PLANNER`, and `IMAGE_DESCRIPTION`. It is **auto-enabled** when `ANTHROPIC_API_KEY` or `CLAUDE_API_KEY` is present in the environment (see `auto-enable.ts`). No actions, providers, evaluators, services, routes, or events are registered — only model handlers and a built-in test suite.

## Plugin surface

The exported `Plugin` object (`anthropicPlugin`) registers these model handlers:

| ModelType | Handler | Default model |
|---|---|---|
| `TEXT_NANO` | `handleTextNano` | falls back to `ANTHROPIC_SMALL_MODEL` |
| `TEXT_SMALL` | `handleTextSmall` | `claude-haiku-4-5-20251001` |
| `TEXT_MEDIUM` | `handleTextMedium` | falls back to `ANTHROPIC_SMALL_MODEL` |
| `TEXT_LARGE` | `handleTextLarge` | `claude-opus-4-7` |
| `TEXT_MEGA` | `handleTextMega` | falls back to `ANTHROPIC_LARGE_MODEL` |
| `TEXT_REASONING_SMALL` | `handleReasoningSmall` | falls back to `ANTHROPIC_SMALL_MODEL` |
| `TEXT_REASONING_LARGE` | `handleReasoningLarge` | falls back to `ANTHROPIC_LARGE_MODEL` |
| `RESPONSE_HANDLER` | `handleResponseHandler` | falls back to `ANTHROPIC_SMALL_MODEL` |
| `ACTION_PLANNER` | `handleActionPlanner` | falls back to `ANTHROPIC_LARGE_MODEL` |
| `IMAGE_DESCRIPTION` | `handleImageDescription` | falls back to `ANTHROPIC_SMALL_MODEL` |

No actions, providers, evaluators, services, routes, or event handlers are registered.

## Layout

```
plugins/plugin-anthropic/
├── index.ts                  # Plugin definition, model dispatch wiring, built-in test suite
├── index.node.ts             # Node/Bun re-export (main entry per package.json exports.node)
├── index.browser.ts          # Browser re-export (package.json exports.browser)
├── auto-enable.ts            # Auto-enable check: reads ANTHROPIC_API_KEY / CLAUDE_API_KEY
├── init.ts                   # initializeAnthropic() — auth mode detection and startup log
├── models/
│   ├── index.ts              # Re-exports all handler functions
│   ├── text.ts               # generateTextWithModel() + all text/reasoning handlers
│   └── image.ts              # handleImageDescription()
├── providers/
│   └── anthropic.ts          # createAnthropicClientWithTopPSupport() — Anthropic SDK client
│                             #   factory; handles API key, OAuth, and topP/temperature patch
├── types/
│   └── index.ts              # Branded types: ModelName, ValidatedApiKey, ModelSize
├── utils/
│   ├── config.ts             # All getSetting() accessors for env vars and model selectors
│   ├── credential-store.ts   # OAuth token resolution: env → keychain → ~/.claude/.credentials.json
│   │                         #   with multi-account pool bridge (Symbol.for("eliza.account-pool..."))
│   ├── claude-cli.ts         # CLI auth mode: generateViaCli / streamViaCli via `claude -p`
│   ├── events.ts             # emitModelUsageEvent() — fires EventType.MODEL_USED after each call
│   └── retry.ts              # executeWithRetry(), formatModelError(), sanitizeUrlForLogs()
└── __tests__/                # Unit and integration tests
```

## Commands

Scripts from `plugins/plugin-anthropic/package.json`:

```bash
bun run --cwd plugins/plugin-anthropic build          # tsdown build (node + browser + cjs)
bun run --cwd plugins/plugin-anthropic dev            # build in watch mode
bun run --cwd plugins/plugin-anthropic test           # run all tests (vitest)
bun run --cwd plugins/plugin-anthropic test:unit      # only __tests__/unit
bun run --cwd plugins/plugin-anthropic test:integration  # only __tests__/integration
bun run --cwd plugins/plugin-anthropic typecheck      # tsgo --noEmit
bun run --cwd plugins/plugin-anthropic lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-anthropic format         # biome format --write
bun run --cwd plugins/plugin-anthropic clean          # rm dist/ .turbo/
```

## Config / env vars

All settings are read via `runtime.getSetting(key)` first, then `process.env[key]`. The `ANTHROPIC_` prefix takes priority; the bare-name fallbacks (e.g. `SMALL_MODEL`) allow cross-provider overrides.

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes (or `CLAUDE_API_KEY` or OAuth) | — | Anthropic API key |
| `CLAUDE_API_KEY` | Alt to above | — | Alias accepted by auto-enable and `getApiKeyOptional` |
| `ANTHROPIC_AUTH_MODE` | No | `apikey` | Set to `claude-cli` (CLI mode via `claude -p`) or `oauth` |
| `ANTHROPIC_SMALL_MODEL` / `SMALL_MODEL` | No | `claude-haiku-4-5-20251001` | Model for TEXT_SMALL, RESPONSE_HANDLER, IMAGE_DESCRIPTION |
| `ANTHROPIC_LARGE_MODEL` / `LARGE_MODEL` | No | `claude-opus-4-7` | Model for TEXT_LARGE, ACTION_PLANNER |
| `ANTHROPIC_NANO_MODEL` / `NANO_MODEL` | No | falls back to small | Model for TEXT_NANO |
| `ANTHROPIC_MEDIUM_MODEL` / `MEDIUM_MODEL` | No | falls back to small | Model for TEXT_MEDIUM |
| `ANTHROPIC_MEGA_MODEL` / `MEGA_MODEL` | No | falls back to large | Model for TEXT_MEGA |
| `ANTHROPIC_REASONING_SMALL_MODEL` | No | falls back to small | Model for TEXT_REASONING_SMALL |
| `ANTHROPIC_REASONING_LARGE_MODEL` | No | falls back to large | Model for TEXT_REASONING_LARGE |
| `ANTHROPIC_RESPONSE_HANDLER_MODEL` / `ANTHROPIC_SHOULD_RESPOND_MODEL` | No | falls back to small | Model for RESPONSE_HANDLER |
| `ANTHROPIC_ACTION_PLANNER_MODEL` / `ANTHROPIC_PLANNER_MODEL` | No | falls back to large | Model for ACTION_PLANNER |
| `ANTHROPIC_BASE_URL` | No | `https://api.anthropic.com/v1` | Node API base URL |
| `ANTHROPIC_BROWSER_BASE_URL` | No | — | Browser proxy base URL (no API key in browser) |
| `ANTHROPIC_EXPERIMENTAL_TELEMETRY` | No | `false` | Enable Vercel AI SDK telemetry |
| `ANTHROPIC_COT_BUDGET` | No | `0` | Chain-of-thought token budget (both sizes) |
| `ANTHROPIC_COT_BUDGET_SMALL` | No | — | CoT budget for small-size models |
| `ANTHROPIC_COT_BUDGET_LARGE` | No | — | CoT budget for large-size models |
| `ANTHROPIC_PROMPT_CACHE_TTL` | No | `5m` | Prompt cache TTL: `"5m"` or `"1h"` |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_OAUTH_TOKEN` | No | — | OAuth bearer token for `ANTHROPIC_AUTH_MODE=oauth` |
| `ANTHROPIC_SUBSCRIPTION_ACCOUNT_ID` | No | `default` | Account ID for app-managed subscription credentials |
| `CLAUDE_CONFIG_DIR` | No | `~/.claude` | Override credential store directory (macOS keychain also checked) |

## How to extend

**Add a new model handler:**
1. Add a handler function in `models/text.ts` following the `handleTextSmall` pattern — call `generateTextWithModel(runtime, params, modelName, modelSize, modelType)`.
2. Export it from `models/index.ts`.
3. Add a config getter in `utils/config.ts` following `getSmallModel` — reads `ANTHROPIC_<SIZE>_MODEL` with a fallback chain.
4. Wire it into the `models` object in `index.ts` using the appropriate `ModelType` key.
5. Add a config entry under the `config` block in `index.ts`.

**Add a model type from an env var:**
Follow the pattern in `utils/config.ts`: `getRawSetting(runtime, "ANTHROPIC_X_MODEL") ?? getRawSetting(runtime, "X_MODEL") ?? fallback`.

## Conventions / gotchas

- **Three auth modes** (`utils/config.ts` `getAuthMode`): `apikey` (default), `oauth`, `cli`. CLI mode (`ANTHROPIC_AUTH_MODE=claude-cli`) spawns `claude -p` via Bun's `Bun.spawn` — fails on Node-only runtimes and does not support `messages`, `tools`, `toolChoice`, or `responseSchema`.
- **Opus 4.x temperature:** `temperature` is forced to `1` for any model whose name contains `opus-4` — the Anthropic API returns 400 otherwise (`models/text.ts` `resolveTextParams`).
- **topP + temperature mutual exclusion:** Anthropic's API rejects requests with both set. The plugin warns and drops `topP` when both are supplied.
- **maxTokens cap:** Opus 4 = 32k, all others = 64k. Values above these are silently capped before the API call.
- **Prompt caching:** `cache_control: ephemeral` is emitted by default on system prompts and stable `promptSegments`. TTL is `5m` unless `ANTHROPIC_PROMPT_CACHE_TTL=1h`. Up to 4 cache breakpoints per request (configurable via `anthropic.maxBreakpoints` in `providerOptions`).
- **Browser build:** `exports.browser` skips `process.env` and `node:*` imports. Use `ANTHROPIC_BROWSER_BASE_URL` to point the browser at a proxy (never expose the API key client-side).
- **Multi-account OAuth pool:** The credential store checks `globalThis[Symbol.for("eliza.account-pool.anthropic.v1")]` for a bridge object. When present, token selection and 401/429 failover route through the pool (`utils/credential-store.ts`).
- **Usage events:** Every successful model call emits `EventType.MODEL_USED` via `emitModelUsageEvent` (`utils/events.ts`), including cache hit/write token counts.
- **Structured output:** Pass `responseSchema` (JSON Schema object) to any text handler. The plugin builds a native AI SDK `output` object; the response is parsed JSON, not a plain string.
- See root `AGENTS.md` for repo-wide architecture rules, logger conventions, and ESM requirements.
