# @elizaos/plugin-cli-inference

TOS-clean SAFE/CLOUD inference route for elizaOS. Serves chat/planner inference by **spawning the sanctioned local CLI** (`claude --print` or `codex exec`) as eliza model handlers. The CLI reads its own subscription credentials from disk — eliza never sees, forwards, or logs the token.

## Purpose / role

This is the develop-shippable peer to the two TOS-gray, never-commit bypass paths:

- the in-process claude-code-stealth fetch interceptor at `packages/agent/src/auth/credentials.ts`, and
- `plugin-codex-cli`'s in-process `postResponses` HTTP path,

both of which replay the consumer-subscription token in-process. Here the handlers SHELL OUT to the official CLI, which loads `~/.claude/.credentials.json` / `~/.codex/auth.json` itself. The token is never injected into the child env (`filterEnv` allowlist + `SENSITIVE_ENV_RE` blocklist) or into logs (stderr is redacted before logging).

Node-only (`"platforms": ["node"]`) — exported from `index.node.ts` only.

## Enable

Single env gate: **`ELIZA_CHAT_VIA_CLI=claude`** or **`ELIZA_CHAT_VIA_CLI=codex`**.

- Unset → the plugin is never added to the resolved set (`auto-enable.ts shouldEnable` is false), and even if force-loaded its models map is empty. INERT; no existing code path changes.
- `claude` / `codex` → the large-tier handlers spawn that CLI.

## Plugin surface

No actions, providers, evaluators, or routes. Model handlers only, and **only the large tier** so high-frequency should-respond/triage calls fall through to the cheap configured provider (bounding per-turn spawn cost to a few ~3-4s calls):

| Model type | Backend |
|---|---|
| `TEXT_LARGE` | `claude --print` or `codex exec` |
| `TEXT_MEGA` | "" |
| `RESPONSE_HANDLER` | "" |

`TEXT_SMALL` / `TEXT_NANO` / `TEXT_MEDIUM` and `ACTION_PLANNER` are intentionally **not** registered (the planner needs GBNF / native-tool enforcement the CLI cannot honor).

## Layout

```
plugins/plugin-cli-inference/
  index.ts                  Plugin entry — gates + registers large-tier handlers; init double-activation guard
  index.node.ts             Node re-export
  index.browser.ts          Browser stub (node-only plugin; empty models)
  auto-enable.ts            shouldEnable = ELIZA_CHAT_VIA_CLI is claude|codex
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
| `ELIZA_CHAT_VIA_CLI` | — | (unset = inert) | `claude` or `codex` — the single enable gate |
| `ELIZA_CLI_CLAUDE_MODEL` | No | `claude-opus-4-7` | `claude --model` |
| `ELIZA_CLI_CODEX_MODEL` | No | `gpt-5.5` | `codex exec -m` |
| `ELIZA_CLI_TIMEOUT_MS` | No | `120000` | per-call spawn timeout (SIGTERM on expiry) |

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
