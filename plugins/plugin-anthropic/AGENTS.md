# @elizaos/plugin-anthropic

Anthropic Claude model provider for elizaOS — registers model handlers for text generation, reasoning, image description, and structured output across all elizaOS `ModelType` tiers.

## Purpose / role

This plugin wires Anthropic Claude models into the elizaOS model dispatch layer. When loaded, it handles every `runtime.useModel()` call for `TEXT_NANO`, `TEXT_SMALL`, `TEXT_MEDIUM`, `TEXT_LARGE`, `TEXT_MEGA`, `TEXT_REASONING_SMALL`, `TEXT_REASONING_LARGE`, `RESPONSE_HANDLER`, `ACTION_PLANNER`, and `IMAGE_DESCRIPTION`. It is **auto-enabled** when `ANTHROPIC_API_KEY` or `CLAUDE_API_KEY` is present in the environment (see `auto-enable.ts`). No actions, providers, evaluators, services, routes, or events are registered — only model handlers and a built-in test suite.

## Plugin surface

The exported `Plugin` object (`anthropicPlugin`) registers these model handlers:

| ModelType | Handler | Default model |
|---|---|---|
| `TEXT_NANO` | `handleTextNano` | falls back to `ANTHROPIC_SMALL_MODEL` |
| `TEXT_SMALL` | `handleTextSmall` | `claude-sonnet-5` |
| `TEXT_MEDIUM` | `handleTextMedium` | falls back to `ANTHROPIC_SMALL_MODEL` |
| `TEXT_LARGE` | `handleTextLarge` | `claude-opus-4-8` |
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
├── index.node.ts             # Node/Bun build entrypoint (re-exports index.ts; build.ts → dist/node)
├── index.browser.ts          # Browser build entrypoint (re-exports index.ts; build.ts → dist/browser)
├── auto-enable.ts            # Auto-enable check: reads ANTHROPIC_API_KEY / CLAUDE_API_KEY
├── init.ts                   # initializeAnthropic() — auth mode detection and startup log
├── models/
│   ├── index.ts              # Re-exports all handler functions
│   ├── text.ts               # generateTextWithModel() + all text/reasoning handlers
│   └── image.ts              # handleImageDescription()
├── prompts/
│   └── evaluators.json       # Evaluator prompt scaffolding (currently empty)
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
└── __tests__/                # credential-store.test.ts, native-plumbing.shape.test.ts,
                              #   native-plumbing.live.test.ts (live API; excluded by default),
                              #   image-description.shape.test.ts, provider-fetch.shape.test.ts
```

## Commands

Scripts from `plugins/plugin-anthropic/package.json`:

```bash
bun run --cwd plugins/plugin-anthropic build          # Bun.build (node + browser + cjs, via build.ts)
bun run --cwd plugins/plugin-anthropic dev            # build in watch mode
bun run --cwd plugins/plugin-anthropic test           # run all tests (vitest, excludes *.live.test.ts)
bun run --cwd plugins/plugin-anthropic test:unit      # vitest --dir __tests__/unit (no unit/ subdir exists; all tests are in __tests__/ root)
bun run --cwd plugins/plugin-anthropic test:integration  # vitest --dir __tests__/integration (no integration/ subdir exists)
bun run --cwd plugins/plugin-anthropic typecheck      # tsgo --noEmit
bun run --cwd plugins/plugin-anthropic lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-anthropic format         # biome format --write
bun run --cwd plugins/plugin-anthropic clean          # rm -rf dist .turbo + tsbuildinfo
```

## Config / env vars

All settings are read via `runtime.getSetting(key)` first, then `process.env[key]`. The `ANTHROPIC_` prefix takes priority; the bare-name fallbacks (e.g. `SMALL_MODEL`) allow cross-provider overrides.

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes (or `CLAUDE_API_KEY` or OAuth) | — | Anthropic API key |
| `CLAUDE_API_KEY` | Alt to above | — | Alias accepted by auto-enable and `getApiKeyOptional` |
| `ANTHROPIC_AUTH_MODE` | No | `apikey` | Set to `claude-cli` (CLI mode via `claude -p`) or `oauth` |
| `ANTHROPIC_SMALL_MODEL` / `SMALL_MODEL` | No | `claude-sonnet-5` | Model for TEXT_SMALL, RESPONSE_HANDLER, IMAGE_DESCRIPTION |
| `ANTHROPIC_LARGE_MODEL` / `LARGE_MODEL` | No | `claude-opus-4-8` | Model for TEXT_LARGE, ACTION_PLANNER |
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
| `ANTHROPIC_EFFORT` | No | — | Reasoning effort (`low`\|`medium`\|`high`\|`xhigh`\|`max`) sent as adaptive thinking + `output_config.effort`; wins over the CoT budget. xhigh/max clamp to high below opus 4.7/fable-5; haiku ignores it (model rejects the parameter) |
| `ANTHROPIC_EFFORT_SMALL` | No | — | Effort for small-size models (what `POST /api/models/config` persists) |
| `ANTHROPIC_EFFORT_LARGE` | No | — | Effort for large-size models |
| `ANTHROPIC_PROMPT_CACHE_TTL` | No | `5m` | Prompt cache TTL: `"5m"` or `"1h"` |
| `ANTHROPIC_TEMPERATURE_LOCKED_MODELS` | No | — | Comma-separated model ids that only accept `temperature=1`, applied on top of the built-in `opus-4` name check |
| `ANTHROPIC_MAX_OUTPUT_TOKENS` | No | — | Output-token cap override: a bare number and/or comma-separated `model-id:tokens` pairs; unlisted models keep the built-in caps |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_OAUTH_TOKEN` | No | — | OAuth bearer token for `ANTHROPIC_AUTH_MODE=oauth` |
| `ANTHROPIC_SUBSCRIPTION_ACCOUNT_ID` | No | `default` | Account ID for app-managed subscription credentials |
| `CLAUDE_CONFIG_DIR` | No | `~/.claude` | Override credential store directory (macOS keychain also checked) |
| `ELIZA_ANTHROPIC_DISABLE_STREAM` | No | — | Set to `1` to force the non-streaming `generateText` path for all requests. Tool-using requests (tools present or `toolChoice` set) already take this path automatically to avoid `AI_NoOutputGeneratedError` on tool_use-only responses. |

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
- **Opus 4.x temperature:** `temperature` is forced to `1` for any model whose name contains `opus-4` — the Anthropic API returns 400 otherwise (`models/text.ts` `resolveTextParams`). New model ids with the same constraint can be listed in `ANTHROPIC_TEMPERATURE_LOCKED_MODELS`.
- **topP + temperature mutual exclusion:** Anthropic's API rejects requests with both set. The plugin warns and drops `topP` when both are supplied.
- **maxTokens cap:** Opus 4 = 32k, all others = 64k. Values above these are silently capped before the API call. `ANTHROPIC_MAX_OUTPUT_TOKENS` overrides the cap per model id (or globally with a bare number).
- **Prompt caching:** `cache_control: ephemeral` is emitted by default on system prompts, stable `promptSegments`, the LAST tool in the tools array, and the kept-trajectory tail (final assistant/tool turn) on the native-messages path. TTL is `5m` unless `ANTHROPIC_PROMPT_CACHE_TTL=1h`; per-segment overrides ride on `PromptSegment.ttl`. The 4-breakpoint API budget is spent system -> tools -> trajectory/segments (`models/text.ts` `buildSegmentCacheControls`); opt out per call with `anthropic.cacheTools: false` / `anthropic.cacheTrajectory: false` in `providerOptions`.
- **Cache visibility:** every call logs a structured `[Anthropic] prompt cache hit|write|none` line (read/write token counts) via `emitModelUsageEvent` (`utils/events.ts`) at debug level.
- **Per-call model override.** Text handlers honor `params.model` before slot-level model settings. Workflow generation uses this for isolated Claude tests without changing every Anthropic text call.
- **Browser build:** `exports.browser` omits `process.env` and `node:*` imports. Use `ANTHROPIC_BROWSER_BASE_URL` to point the browser at a proxy (never expose the API key client-side).
- **Multi-account OAuth pool:** The credential store reads the shared `ANTHROPIC_ACCOUNT_POOL_BRIDGE_SYMBOL` bridge accessor from `@elizaos/core`. When present, token selection and 401/429 failover route through the pool (`utils/credential-store.ts`).
- **Usage events:** Every successful model call emits `EventType.MODEL_USED` via `emitModelUsageEvent` (`utils/events.ts`), including cache hit/write token counts.
- **Structured output:** Pass `responseSchema` (JSON Schema object) to any text handler. The plugin builds a native AI SDK `output` object; the response is parsed JSON, not a plain string.
- See root `AGENTS.md` for repo-wide architecture rules, logger conventions, and ESM requirements.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — model provider:**
- A trajectory from a **live** call to this provider (not the proxy, not a mock): full request, raw response, token usage, finish reason, and streamed chunks.
- Proof of tool/function-calling and structured-output parsing against the real model.
- The error paths exercised: bad key, model-not-found, oversized context, timeout, rate-limit, mid-stream disconnect — plus latency and cost from the real call.
- If no key is available in CI, attach the documented live-run transcript as evidence — never a mocked client passed off as a pass.
<!-- END: evidence-and-e2e-mandate -->
