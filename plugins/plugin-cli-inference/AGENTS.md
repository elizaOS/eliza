# @elizaos/plugin-cli-inference

TOS-clean SAFE/CLOUD inference route for elizaOS. Serves chat/planner inference by **spawning the sanctioned local CLI** (`claude --print` or `codex exec`) as eliza model handlers. The CLI reads its own subscription credentials from disk — eliza never sees, forwards, or logs the token.

## Purpose / role

This is the develop-shippable peer to the two TOS-gray, never-commit bypass paths:

- the in-process claude-code-stealth fetch interceptor at `packages/agent/src/auth/credentials.ts`, and
- `plugin-codex-cli`'s in-process `postResponses` HTTP path,

both of which replay the consumer-subscription token in-process. Here the handlers SHELL OUT to the official CLI, which loads `~/.claude/.credentials.json` / `~/.codex/auth.json` itself. The token is never injected into the child env (`filterEnv` allowlist + `SENSITIVE_ENV_RE` blocklist) or into logs (stderr is redacted before logging).

Node-only (`"platforms": ["node"]`) — exported from `index.node.ts` only.

## Enable

Single env gate: **`ELIZA_CHAT_VIA_CLI=claude`**, **`claude-sdk`**, or **`codex`**.

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
| `ELIZA_CLI_CODEX_MODEL` | No | `gpt-5.5` | `codex exec -m` |
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
- **sandbox.ts is a copy.** Keep in sync with `packages/plugin-sub-agent-claude-code/src/sandbox.ts` if `SENSITIVE_ENV_RE` / `SAFE_ENV_KEYS` change upstream.
- **Multi-account/AccountPool failover is OUT of v1** — the CLI owns one on-disk cred set. Single-token chat-inference is a documented gap.
- See the root `AGENTS.md` for repo-wide architecture rules, logger conventions, and ESM requirements.
