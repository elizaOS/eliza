# @elizaos/plugin-groq

Groq LLM provider — fast inference via Groq's API for text generation, audio transcription, and text-to-speech.

## Purpose / role

Registers model handlers so Eliza agents can use Groq as an inference backend. Auto-enabled when `GROQ_API_KEY` is present in the environment (via `auto-enable.ts` + `elizaos.plugin.autoEnableModule`). No actions, providers, evaluators, routes, or services — this is a pure model-handler plugin. Declared capabilities: `text-large`, `text-small`, `tool-use`, `text-to-speech`.

## Plugin surface

No actions, providers, evaluators, routes, or events are registered.

**Model handlers** (all in `index.ts`):

| Model type | What it does |
|---|---|
| `TEXT_NANO` | Text generation routed to nano model (falls back to small model) |
| `TEXT_SMALL` | Text generation; supports tools, toolChoice, responseSchema, messages |
| `TEXT_MEDIUM` | Text generation routed to medium model (falls back to small) |
| `TEXT_LARGE` | Text generation; supports tools, toolChoice, responseSchema, messages |
| `TEXT_MEGA` | Text generation routed to mega model (falls back to large) |
| `RESPONSE_HANDLER` | Response routing decisions — defaults to nano tier |
| `ACTION_PLANNER` | Action planning — defaults to large tier (reasoning-heavy) |
| `TRANSCRIPTION` | Audio transcription via `whisper-large-v3-turbo`; Node-only; POST to `/audio/transcriptions` |
| `TEXT_TO_SPEECH` | Speech synthesis via Groq's `/audio/speech`; Node-only; returns `Uint8Array` |

## Layout

```
plugins/plugin-groq/
  index.ts              Plugin definition, all model handlers, retry logic, token-usage helpers
  auto-enable.ts        Checks for GROQ_API_KEY — used by elizaOS plugin auto-enable engine
  index.node.ts         Node entry — re-exports index.ts
  index.browser.ts      Browser entry — re-exports index.ts
  build.ts              Bun.build script (node + browser targets)
  __tests__/
    behavior.test.ts            Plugin registration contract shape tests
    retry.test.ts               classifyRetryError unit tests
    model-usage.test.ts         Token usage normalisation tests
    native-plumbing.shape.test.ts  Native tool-call / structured-output plumbing
    error-policy.shape.test.ts  #12182 failure-path surfaces (typed errors, no fabricated completions)
    core-test-mock.ts           Shared mock helpers
  prompts/
    evaluators.json     (bundled prompt data)
```

## Commands

All scripts run from the package root via:

```bash
bun run --cwd plugins/plugin-groq build         # Bun.build compile (node + browser)
bun run --cwd plugins/plugin-groq dev           # watch mode build
bun run --cwd plugins/plugin-groq test          # vitest run
bun run --cwd plugins/plugin-groq typecheck     # tsgo --noEmit
bun run --cwd plugins/plugin-groq lint          # biome check --write --unsafe
bun run --cwd plugins/plugin-groq lint:check    # biome check (read-only)
bun run --cwd plugins/plugin-groq format        # biome format --write
bun run --cwd plugins/plugin-groq format:check  # biome format (read-only)
bun run --cwd plugins/plugin-groq clean         # rm -rf dist
```

## Config / env vars

| Env var | Required | Default | Notes |
|---|---|---|---|
| `GROQ_API_KEY` | Yes (Node) | — | Triggers auto-enable; omit in browser (use proxy instead) |
| `GROQ_BASE_URL` | No | `https://api.groq.com/openai/v1` | Override for proxies |
| `GROQ_NANO_MODEL` | No | falls back to `GROQ_SMALL_MODEL` | |
| `GROQ_SMALL_MODEL` | No | `openai/gpt-oss-120b` | Also reads `SMALL_MODEL` fallback |
| `GROQ_MEDIUM_MODEL` | No | falls back to small | Also reads `MEDIUM_MODEL` |
| `GROQ_LARGE_MODEL` | No | `openai/gpt-oss-120b` | Also reads `LARGE_MODEL` |
| `GROQ_MEGA_MODEL` | No | falls back to large | Also reads `MEGA_MODEL` |
| `GROQ_RESPONSE_HANDLER_MODEL` | No | nano tier | Also reads `GROQ_SHOULD_RESPOND_MODEL` / `RESPONSE_HANDLER_MODEL` / `SHOULD_RESPOND_MODEL` |
| `GROQ_ACTION_PLANNER_MODEL` | No | large tier | Also reads `GROQ_PLANNER_MODEL` / `ACTION_PLANNER_MODEL` / `PLANNER_MODEL` |
| `GROQ_TRANSCRIPTION_MODEL` | No | `whisper-large-v3-turbo` | Also reads `TRANSCRIPTION_MODEL`; overrides the ASR model used by the `TRANSCRIPTION` handler |
| `GROQ_TTS_MODEL` | No | `canopylabs/orpheus-v1-english` | |
| `GROQ_TTS_VOICE` | No | `autumn` (code default) / `troy` (agentConfig) | Per-call `voice` param overrides this |
| `GROQ_TTS_RESPONSE_FORMAT` | No | `wav` | |
| `GROQ_ALLOW_BROWSER_API_KEY` | No | `false` | Set `"true"` to send API key from browser context |

All vars are read via `runtime.getSetting(...)` at call time (not cached at init).

## How to extend

**Add a model handler:** In `index.ts`, add a new key to the `models` object inside `groqPlugin`. Use the existing `handleTextModel` helper or write a direct handler for non-text types. Follow the pattern of `TRANSCRIPTION` or `TEXT_TO_SPEECH` for non-SDK paths.

**Add a new model-tier getter:** Add a `get<Tier>Model(runtime)` function following the pattern of `getNanoModel` / `getMegaModel`. Wire it into `getTextModelForType`'s switch statement and expose the corresponding env var in `groqPlugin.config`.

**Add evaluators/actions/providers:** This plugin currently has none. If you add them, follow the root AGENTS.md architecture rules and register them in the `groqPlugin` object under `evaluators`, `actions`, or `providers` keys.

## Conventions / gotchas

- **Browser restrictions:** `TRANSCRIPTION` and `TEXT_TO_SPEECH` throw immediately in browser contexts. Text generation works in browser if `GROQ_BASE_URL` points to a proxy and `GROQ_ALLOW_BROWSER_API_KEY` is not `"true"`.
- **Retry logic:** `generateWithRetry` wraps AI SDK's built-in retry (3 attempts, exponential backoff). The outer loop adds up to 5 rate-limit retries (honoring `try again in Ns` from the error message) and 2 transient-error retries. `classifyRetryError` is exported and unit-tested in `__tests__/retry.test.ts`.
- **Tool calling / structured output:** Handlers transparently return the native AI SDK result shape (with `toolCalls`, `finishReason`, `usage`) when callers pass `tools`, `toolChoice`, `responseSchema`, or `messages`. Plain `prompt`-only calls return a plain string.
- **Token usage:** Emits `EventType.MODEL_USED` after every successful generation. Falls back to `estimateUsage` (chars/4 heuristic) if the API returns no usage data.
- **`AI_SDK_LOG_WARNINGS`:** Set to `false` at module load to suppress noisy SDK warnings globally.
- **No src/ directory:** All source lives directly under `plugins/plugin-groq/` (not under `src/`).

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

**Capture & manually review for this package — model provider:**
- A trajectory from a **live** call to this provider (not the proxy, not a mock): full request, raw response, token usage, finish reason, and streamed chunks.
- Proof of tool/function-calling and structured-output parsing against the real model.
- The error paths exercised: bad key, model-not-found, oversized context, timeout, rate-limit, mid-stream disconnect — plus latency and cost from the real call.
- If no key is available in CI, attach the documented live-run transcript as evidence — never a mocked client passed off as a pass.
<!-- END: evidence-and-e2e-mandate -->
