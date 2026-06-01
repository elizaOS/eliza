# @elizaos/plugin-sub-agent-claude-code

Reference remote-mode sub-agent plugin: drives the Claude Code CLI inside an isolated Bun subprocess via `ClaudeCodeSubAgentService`.

## Purpose / role

This plugin lets an Eliza agent spawn and communicate with the Claude Code CLI as a subprocess, with OS-level sandboxing (macOS `sandbox-exec`, Linux `bwrap`) and SOC2-aligned hardening for env filtering, cwd validation, and binary allowlisting. It implements the `plugin-worker-runtime` remote-plugin contract and is loaded via `runtime.installRemotePlugin(plugin, { source: { kind: "workspace", pkgName: "@elizaos/plugin-sub-agent-claude-code" } })`. The worker entry is `dist/worker.js`; the host entry (`dist/plugin.js`) exports the `Plugin` descriptor. For repo-wide conventions see the root `AGENTS.md`.

## Layout

```
packages/plugin-sub-agent-claude-code/
  src/
    plugin.ts            Plugin descriptor export (entry for host-side)
    worker.ts            Worker entrypoint: calls bootstrap(plugin)
    sub-agent-service.ts ClaudeCodeSubAgentService — session lifecycle, spawn, RPC
    sandbox.ts           OS sandboxing helpers (filterEnv, resolveSafeCwd, resolveSafeBinary, buildSandboxedCommand)
    session-recorder.ts  Per-session transcript writer + pruneOldSessions (SOC2 O-8)
    sandbox.test.ts      Unit tests for sandbox.ts helpers
  sandbox/
    macos.sb             macOS sandbox-exec profile (Seatbelt)
    linux-bwrap.sh       Linux bwrap wrapper script
    SMOKE.md             Manual sandbox verification steps
  dist/                  Build output (plugin.js, worker.js, *.d.ts)
  tsconfig.json
  tsconfig.build.json
  package.json
```

## Key exports / surface

**`dist/plugin.js` (main entry `"."`):**
- `plugin` — the `Plugin` descriptor object. `mode: "remote"`, registers `ClaudeCodeSubAgentService`.
- `default` — same as `plugin`.

**`dist/worker.js` (export `"./worker"`):**
- Worker entrypoint. Calls `@elizaos/plugin-worker-runtime`'s `bootstrap(plugin)` and enters the announce/dispatch loop.

**Service registered:** `ClaudeCodeSubAgentService`
- `serviceType`: `"sub-agent.claude-code"`
- RPC methods (callable from host via worker-runtime IPC):
  - `createSession(params)` — spawn `claude` CLI subprocess in a sandboxed env; returns `{ sessionId, createdAt, sandbox }`.
  - `sendPrompt({ sessionId, prompt })` — write a prompt line to the subprocess stdin.
  - `getOutput({ sessionId, mode? })` — read buffered stdout lines (`mode: "all"` or `"since-last"`).
  - `terminate({ sessionId })` — SIGTERM the subprocess and finalize the session transcript.
  - `listSessions()` — list active sessions with cwd, model, sandbox type.

**Plugin remote config:**
- `role: "sub-agent"`, `isolation: "isolated-process"` — spawned via `Bun.spawn`, not a Worker thread.
- Network allowlist: `api.anthropic.com` only.
- Host events emitted: `sub-agent.session.created`, `sub-agent.session.terminated`.
- `lifetime: "session"` — torn down when the agent session ends.

## Commands

```bash
bun run --cwd packages/plugin-sub-agent-claude-code build
bun run --cwd packages/plugin-sub-agent-claude-code typecheck
bun run --cwd packages/plugin-sub-agent-claude-code test
bun run --cwd packages/plugin-sub-agent-claude-code lint
bun run --cwd packages/plugin-sub-agent-claude-code lint:fix
bun run --cwd packages/plugin-sub-agent-claude-code clean
```

## Config / env vars

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Available to the worker process via Bun env permissions (`remote.permissions.bun.env`). Cannot be forwarded to the claude subprocess via `extraEnv` — `filterEnv` throws for keys matching `SENSITIVE_ENV_RE` (`API_KEY` pattern matches). |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Available to the worker process via Bun env permissions. Cannot be forwarded via `extraEnv` — `TOKEN` pattern matches `SENSITIVE_ENV_RE`. |
| `ELIZA_WORKSPACE_DIR` | — | Workspace root for `cwd` validation. Falls back to `ELIZA_STATE_DIR`, then `process.cwd()`. |
| `ELIZA_STATE_DIR` | — | State dir; used as workspace root fallback. |
| `ELIZA_SUB_AGENT_SESSIONS_DIR` | `~/.eliza/sub-agent-sessions` | Directory for per-session transcript logs. |
| `ELIZA_SUB_AGENT_SESSION_RETENTION_DAYS` | `30` | Days before transcript directories are pruned. |

`ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are granted to the worker process via `remote.permissions.bun.env` in `plugin.ts`, so the worker itself can read them from `process.env`. They cannot be forwarded to the claude subprocess via `params.extraEnv` — `filterEnv` throws when any `extraEnv` key matches `SENSITIVE_ENV_RE` (`/(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|DATABASE_URL|WALLET|PRIVATE|MNEMONIC|API_KEY)/i`), and both keys match. Only non-sensitive keys (e.g. `ANTHROPIC_BASE_URL`) may be passed via `extraEnv`.

## How to extend

**Add a new RPC method:**
1. Add the method to `ClaudeCodeSubAgentService` in `src/sub-agent-service.ts`.
2. Add its name to `ClaudeCodeSubAgentService.rpcMethods` (the `as const` tuple).
3. The worker-runtime dispatch loop will route calls to it automatically.

**Change sandbox permissions (macOS):**
Edit `sandbox/macos.sb` (Seatbelt profile). Key parameters passed by `buildSandboxedCommand`: `WORKSPACE`, `SESSION`, `HOME`, `TMPDIR`. Run the smoke tests in `sandbox/SMOKE.md` after changes.

**Change sandbox permissions (Linux):**
Edit `sandbox/linux-bwrap.sh`. The script receives `workspaceRoot` and `sessionId` as positional args before `--`.

**Add a new whitelisted binary directory:**
Add the absolute path to `BINARY_DIR_ALLOWLIST` in `src/sandbox.ts`.

## Conventions / gotchas

- **No `@elizaos/core` dep.** The Plugin shape is intentionally loosely typed to avoid pulling the full core dep tree into the worker process. The worker-runtime validates structurally.
- **`cwd` must be absolute and under a workspace root or `/tmp`.** Symlink escapes are rejected via `realpathSync`. Pass absolute paths; relative paths throw `SubAgentCwdError`.
- **Binary resolution uses a static whitelist.** The `claude` binary must be in one of the dirs in `BINARY_DIR_ALLOWLIST` (`/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin`, `~/.local/bin`, `~/.bun/bin`, `~/.cargo/bin`). Paths outside the list throw `SubAgentBinaryError`.
- **Missing sandbox helper is a WARN, not an error.** Dev boxes without `bwrap` or `sandbox-exec` still spawn processes with env-allowlist-only. Production deploys should treat this WARN as a P1 fix.
- **Session transcripts are redacted before write.** `SessionRecorder` strips common credential patterns (API keys, GH tokens, Slack tokens, ETH/BTC addresses, card numbers) before flushing to disk. This is a coarse pass; combine with workspace isolation.
- **`pruneOldSessions` is fire-and-forget.** Called at service start; errors are silently swallowed (non-critical cleanup).
- **Stdout is pumped asynchronously.** `pumpStdout` runs in the background; `getOutput` reads from the in-memory buffer, not directly from the stream.
