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
  index.browser.ts          Unsupported browser export; plugin is node-only
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
- **Per-call model override.** Text handlers honor `params.model` before `CODEX_MODEL`. Workflow generation uses this for isolated Codex model tests without changing every Codex CLI text call.
- **Auth file lock.** `codex-auth.ts` uses a `.lock` file alongside `auth.json` (30 s stale timeout, 30 retries at 100 ms). Stale locks are cleaned up automatically.
- **Supported models:** `gpt-5`, `gpt-5-codex`, `gpt-5.4`, `gpt-5.5`, `gpt-5.5-pro`. Setting `CODEX_MODEL` to anything else will be sent as-is; the backend may reject it.
- See the root `AGENTS.md` for repo-wide architecture rules, logger conventions, and ESM requirements.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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

**Capture & manually review for this package — CLI / tooling:**
- The real command/flow invocation transcript (args in, stdout/stderr, exit code) and the artifacts it generated (files, scaffolds, manifests, screenshots/recordings).
- Failure paths: bad args, missing deps, partial state, permission/network errors.
- A recording/log of the actual run end to end — not a unit test of one helper.
- Any model interaction captured as a live trajectory and reviewed.
<!-- END: evidence-and-e2e-mandate -->
