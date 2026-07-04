# @elizaos/plugin-cli-inference

TOS-clean SAFE/CLOUD inference route for elizaOS. Serves chat/planner inference by **spawning the sanctioned local CLI** (`claude --print` or `codex exec`) as eliza model handlers. The CLI reads its own subscription credentials from disk — eliza never sees, forwards, or logs the token.

## Purpose / role

This is the develop-shippable peer to the two TOS-gray, never-commit bypass paths:

- the in-process claude-code-stealth fetch interceptor at `packages/agent/src/auth/credentials.ts`, and
- `plugin-codex-cli`'s in-process `postResponses` HTTP path,

both of which replay the consumer-subscription token in-process. Here the handlers SHELL OUT to the official CLI, which loads `~/.claude/.credentials.json` / `~/.codex/auth.json` itself. The token is never injected into the child env (`filterEnv` allowlist + `SENSITIVE_ENV_RE` blocklist) or into logs (stderr is redacted before logging).

Node-only (`"platforms": ["node"]`) — exported from `index.node.ts` only.

## Enable

Single env gate: **`ELIZA_CHAT_VIA_CLI=claude`**, **`claude-sdk`**, **`codex`**, or **`codex-sdk`**.

- Unset → the plugin is never added to the resolved set (`auto-enable.ts shouldEnable` is false), and even if force-loaded its models map is empty. INERT; no existing code path changes.
- `claude` / `codex` → the large-tier handlers **cold-spawn** that CLI per call (`claude --print` / `codex exec`).
- `claude-sdk` → the handlers run a **warm Claude Agent SDK session** (one persistent process per `(model, systemPrompt, mode)`), not a per-call spawn. This is the fast + TOS-clean path: ~1-2s warm vs the CLI's 25-68s cold-spawn-per-call, and it does **native tool-calling** for the planner. See "Warm Agent SDK backend" below.

## Plugin surface

No actions, providers, evaluators, or routes. Model handlers only, and **only the large tier** so high-frequency should-respond/triage calls fall through to the cheap configured provider (bounding per-turn spawn cost to a few ~3-4s calls):

| Model type | Backend |
|---|---|
| `TEXT_LARGE` | `claude --print` or `codex exec` |
| `TEXT_MEGA` | "" |
| `RESPONSE_HANDLER` | "" |
| `ACTION_PLANNER` | "" — **only when `ELIZA_PLANNER_NATIVE_TOOLS=0`** (text-planner mode) |

`TEXT_SMALL` / `TEXT_NANO` / `TEXT_MEDIUM` are intentionally **not** registered (high-frequency triage tiers fall through to the cheap provider).

`ACTION_PLANNER` is **conditional**: in the default native-tools mode
(`ELIZA_PLANNER_NATIVE_TOOLS=1`) it is **not** registered, because that planner
needs GBNF / native-tool grammar the free-text CLI cannot honor — so the planner
stays on a grammar-honoring provider while the CLI still serves the user-facing
reply (`RESPONSE_HANDLER`) and large generations (`TEXT_LARGE`). In **text-planner
mode** (`ELIZA_PLANNER_NATIVE_TOOLS=0`) the CLI **does** register and serve
`ACTION_PLANNER`: the grammar-heavy planner prompt is rewritten into a clean
"pick ONE action, emit `{action, params}` JSON" routing prompt (see
`clean-routing-planner.ts`, proven live with `claude --print --model
claude-opus-4-8`). This is how the **whole brain** (chat + planner + coding) can
run on a single Claude Max subscription **TOS-clean**, no API key, no stealth.
Note: the per-turn `claude` subprocess makes the text-planner path slower than a
direct-API provider (~tens of seconds for a planner turn) — use the `claude-sdk`
backend below to keep the clean path fast.

## Warm Agent SDK backend (`ELIZA_CHAT_VIA_CLI=claude-sdk`)

The fast, TOS-clean way to run the whole brain on a Claude Max subscription.
Effective 2026-06-15 Anthropic grants subscriptions a monthly **Agent SDK
credit**, so driving the brain through `@anthropic-ai/claude-agent-sdk` (which
reads `~/.claude` / `CLAUDE_CODE_OAUTH_TOKEN` itself — eliza never sees the
token) is **officially sanctioned**, strictly cleaner than the stealth
token-replay. The SDK is loaded via a variable dynamic import (`src/claude-sdk-session.ts`)
so the plugin stays inert and never imports it unless this backend is set.

A `ClaudeSdkSession` keeps ONE warm streaming-input `query()` process alive, so
the cold-start is paid once, not per call. Two modes:

- **TEXT mode** (`generate`) — `RESPONSE_HANDLER` / `TEXT_LARGE` / `TEXT_MEGA`.
  `allowedTools: []` + `settingSources: []` strip Claude Code's own tools and
  project context → a warm chat-completion engine. The model is reframed as a
  pure completion engine (`frameTextSystemPrompt` system prefix + a closing
  `appendTextDirective`) so it synthesizes the final reply from already-executed
  tool results rather than narrating agentic intent ("I'll fetch it…").
- **ROUTE mode** (`route`) — `ACTION_PLANNER` (text-planner mode). A single
  in-process MCP tool `route_action({action, params})` is the only allowed tool.
  The model emits a **native `tool_use`**; the SDK routes it to our handler
  in-process; the handler captures `{action, params}` and **eliza executes the
  action** (Claude Code never does). This matches the stealth/native path's full
  functionality (WEB_FETCH, sub-agents) with no free-text JSON parsing and no
  required-tool retry loop. The returned bare `{action, params}` is consumed by
  the loop's existing text-mode parser — no core change.

Sessions are keyed by `(model, mode, sha256(systemPrompt))` because the SDK
freezes `systemPrompt` + `mcpServers` at `query()` start (no mid-session reset);
`setModel()` switches tiers live on one process. Calls are serialized; the
session self-heals on error and restarts after `restartAfterTurns` (default 20)
to bound context growth. The `result` envelope is inspected so an
`error_max_turns`/empty turn falls back to `result.result` instead of throwing a
spurious "empty completion".

Per-tier models: `ELIZA_CLI_CLAUDE_PLANNER_MODEL` (small/planner, e.g. sonnet) +
`ELIZA_CLI_CLAUDE_MODEL` (large, e.g. opus); `ELIZA_CLI_CLAUDE_BIN` points the
SDK at the Claude Code executable.

**Caveat:** the monthly Agent SDK credit can run dry mid-month (the SDK then
returns a session-limit error); plan a fallback (a key/Cloud tier, or stealth on
a self-host) for production continuity.

## Warm Codex SDK backend (`ELIZA_CHAT_VIA_CLI=codex-sdk`)

The codex peer of `claude-sdk` (`src/codex-sdk-session.ts`). Runs the brain on a
ChatGPT/Codex subscription via `@openai/codex-sdk` (loaded by variable dynamic
import; reads `~/.codex/auth.json` itself). A `CodexSdkSession` keeps ONE warm
`Thread` (`codex.startThread()` once, `thread.run()` per turn) instead of the
`codex exec` cold-spawn-per-call. Two modes:

- **TEXT** (`generate`): `thread.run(body)` with `sandboxMode:"read-only"`,
  `approvalPolicy:"never"`, `networkAccessEnabled:false` → a warm completion
  engine; returns the turn's `finalResponse`.
- **ROUTE** (`route`): codex NATIVE structured output (`outputSchema`) constrains
  the turn to `{action, params}` (params as a JSON string for OpenAI strict mode),
  reliable at scale. REQUIRES `ELIZA_CLI_CODEX_BIN` pointing at the system codex —
  the SDK bundles an old codex (0.80.0) that rejects current models/structured output.

codex-sdk has no thread-level system prompt, so the system is folded into the
body and ONE warm thread per `(model, mode)` serves every system prompt. Per-tier
models: `ELIZA_CLI_CODEX_PLANNER_MODEL` + `ELIZA_CLI_CODEX_MODEL`;
`ELIZA_CLI_CODEX_REASONING_EFFORT` sets `modelReasoningEffort`.

**Status:** LIVE-VERIFIED in the bot on a ChatGPT/Codex sub — btc \$59,527, eth
\$1,566, weather, identity, knows-user, 8×8=64; live-info routes to WEB_FETCH and
synthesizes the real fetched value (after the canonical-contentToText fix). Needs
`ELIZA_CLI_CODEX_BIN`=system codex. 12 fake-SDK unit tests.

## Layout

```
plugins/plugin-cli-inference/
  index.ts                  Plugin entry — gates + registers large-tier handlers; init double-activation guard
  index.node.ts             Node re-export
  index.browser.ts          Browser stub (node-only plugin; empty models)
  auto-enable.ts            shouldEnable = ELIZA_CHAT_VIA_CLI is claude|claude-sdk|codex
  src/
    claude-cli.ts           ClaudeCli — spawns `claude --print`; __setSpawnForTests seam
    codex-cli-exec.ts       CodexCli — spawns `codex exec --json`; JSONL last-assistant parse
    prompt-flatten.ts       system/developer -> system slot; user/assistant/tool -> body; nothing dropped
    sandbox.ts              SOC2 helpers copied from plugin-sub-agent-claude-code (filterEnv/resolveSafeCwd/resolveSafeBinary/SENSITIVE_ENV_RE)
  __tests__/
    cli-inference.test.ts   Unit tests (mock spawn): argv, token-absence, threading, parse, throw-on-error, large-tier-only
  build.ts  vitest.config.ts  tsconfig*.json  biome.json
```

## GenerateTextParams -> CLI mapping (HARD REQ: forward BOTH system AND messages/prompt)

- **claude:** `[claude, -p <flattened body>, --system-prompt <params.system FULL REPLACE>, --exclude-dynamic-system-prompt-sections, --output-format text, --model <ELIZA_CLI_CLAUDE_MODEL || claude-opus-4-7>]`, stdin `/dev/null`, cwd = isolated empty tmpdir, env = `filterEnv(process.env)`.
- **codex:** `[codex, exec, -m <ELIZA_CLI_CODEX_MODEL || gpt-5.5>, -s read-only, --skip-git-repo-check, -C <cwd>, --color never, --json, <system folded on top of flattened body>]`.

`prompt-flatten` re-routes system/developer roles to the system slot and flattens user/assistant/tool turns into the body; messages are NEVER dropped (would strip skills/memory/recent-convo/grammar).

## Config / env vars

| Var | Required | Default | Description |
|---|---|---|---|
| `ELIZA_CHAT_VIA_CLI` | — | (unset = inert) | `claude`, `claude-sdk`, or `codex` — the single enable gate |
| `ELIZA_CLI_CLAUDE_MODEL` | No | `claude-opus-4-7` | claude large-tier model (`--model` / SDK large tier) |
| `ELIZA_CLI_CLAUDE_PLANNER_MODEL` | No | (falls back to large) | `claude-sdk` small/planner tier model (e.g. sonnet) |
| `ELIZA_CLI_CLAUDE_BIN` | No | (SDK default) | `claude-sdk`: path to the Claude Code executable the SDK drives |
| `ELIZA_CLI_SDK_RESTART_AFTER_TURNS` | No | `20` | `claude-sdk`: restart a warm session after N turns (bounds context) |
| `ELIZA_CLI_CODEX_MODEL` | No | `gpt-5.5` | codex large-tier model (`codex exec -m` / SDK large tier) |
| `ELIZA_CLI_CODEX_PLANNER_MODEL` | No | (falls back to large) | `codex-sdk` small/planner tier model |
| `ELIZA_CLI_CODEX_REASONING_EFFORT` | No | (sdk default) | `codex-sdk`: `modelReasoningEffort` (minimal..xhigh) |
| `ELIZA_CLI_CODEX_BIN` | No | (sdk bundled) | `codex-sdk`: path to the system codex binary (REQUIRED — bundled 0.80.0 rejects current models) |
| `ELIZA_CLI_TIMEOUT_MS` | No | `120000` | per-call spawn timeout (SIGTERM on expiry; CLI backends) |

## Errors

Handlers THROW on non-zero exit / timeout (`+SIGTERM`) / empty stdout so `useModel` + AccountPool failover treat them as provider failures — never swallow-and-return-empty. stderr is redacted via `SENSITIVE_ENV_RE` before it reaches the error message or log.

## Commands

```bash
bun run --cwd plugins/plugin-cli-inference test       # vitest (mocks spawn; no real CLI)
bun run --cwd plugins/plugin-cli-inference typecheck
bun run --cwd plugins/plugin-cli-inference lint:check
bun run --cwd plugins/plugin-cli-inference build
```

## Conventions / gotchas

- **Node-only.** `index.browser.ts` is a stub; the real handlers use `node:child_process`.
- **Double-activation guard.** `ELIZA_CHAT_VIA_CLI=claude` + `ELIZA_ENABLE_CLAUDE_STEALTH` both set throws in `init()` (two colliding claude routes). The guard lives in THIS plugin because `credentials.ts` is skip-worktree on the live branch.
- **Isolated cwd per call.** Created with `mkdtemp` under `tmpdir()`, validated by `resolveSafeCwd`, removed in a `finally`. Keeps the CLI out of real projects (suppresses Claude Code repo-context identity).
- **`/dev/null` stdin is REQUIRED** — without it the CLI waits ~3s for stdin.
- **sandbox.ts is a copy.** Keep in sync with `packages/plugin-remote-manifest/src/sub-agent-claude-code/sandbox.ts` if `SENSITIVE_ENV_RE` / `SAFE_ENV_KEYS` change upstream.
- **Multi-account pool auth + rotation (SDK backends only).** The `claude-sdk` / `codex-sdk` chat brain consults the shared `CODING_AGENT_SELECTOR_BRIDGE_SYMBOL` bridge accessor from `@elizaos/core` (in `src/account-rotation.ts`) POOL-FIRST: the FIRST warm-session auth selects a healthy pooled account and materializes its subprocess-only SDK env (`CLAUDE_CODE_OAUTH_TOKEN` / per-account `CODEX_HOME`), so an app-connected subscription is used immediately — the ambient `~/.claude` / `CLAUDE_CODE_OAUTH_TOKEN` credential is only the fallback when the pool is empty or selection fails. On a subscription-limit throw it then rotates to the next healthy pooled account before falling to provider failover — see issue #11180. Rotation evicts the warm session so it re-auths as the new account and retries transparently without mutating the parent `process.env`. Only rate-limit-class errors rotate; non-limit errors rethrow straight to failover. Default ON when a pool is present; opt out with `ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION=0`. The COLD `claude --print` / `codex exec` CLIs still own one on-disk cred set (pool auth is SDK-only; the bare-CLI shim is issue #11180 Gap B).
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

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — model provider:**
- A trajectory from a **live** call to this provider (not the proxy, not a mock): full request, raw response, token usage, finish reason, and streamed chunks.
- Proof of tool/function-calling and structured-output parsing against the real model.
- The error paths exercised: bad key, model-not-found, oversized context, timeout, rate-limit, mid-stream disconnect — plus latency and cost from the real call.
- If no key is available in CI, attach the documented live-run transcript as evidence — never a mocked client passed off as a pass.
<!-- END: evidence-and-e2e-mandate -->
