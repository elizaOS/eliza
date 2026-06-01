# @elizaos/plugin-sub-agent-claude-code

elizaOS plugin that drives the [Claude Code](https://github.com/anthropics/claude-code) CLI as a sub-agent inside an isolated subprocess.

## What it does

The plugin wraps the `claude` CLI binary in an OS-sandboxed Bun subprocess and exposes session management over host-RPC so an Eliza agent can:

- Spawn a Claude Code session pointed at a workspace directory.
- Send prompts to the session over stdin.
- Read buffered stdout output on demand.
- Terminate the session when done.

Hardening covers SOC2 controls A-2, A-3, and O-8:

- **Env filtering** — only an explicit allowlist of env keys is forwarded to the child process; a blocklist regex drops any credential-shaped keys.
- **CWD validation** — the working directory is resolved via `realpath` and must be under a workspace root or `/tmp`; symlink escapes are rejected.
- **Binary allowlisting** — the `claude` binary is resolved against a static whitelist of directories (`/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin`, `~/.bun/bin`, etc.).
- **OS sandboxing** — macOS uses `sandbox-exec` with a Seatbelt profile (`sandbox/macos.sb`); Linux uses `bwrap` via `sandbox/linux-bwrap.sh`. When neither helper is available the plugin logs a WARN and falls back to allowlist-only.
- **Session transcripts** — each session's I/O is redacted and written to `~/.eliza/sub-agent-sessions/<sessionId>/transcript.log`; an audit event carrying the transcript hash is emitted on termination.

## Installation

This package is `private: true` and intended for use as a workspace dependency within the elizaOS monorepo. It is loaded via `plugin-worker-runtime`'s remote-plugin mechanism:

```ts
import { plugin } from "@elizaos/plugin-sub-agent-claude-code";

await runtime.installRemotePlugin(plugin, {
  source: { kind: "workspace", pkgName: "@elizaos/plugin-sub-agent-claude-code" },
  lifetime: "session",
});
```

## Usage

After installation, obtain the service and call its RPC methods:

```ts
const svc = await runtime.getService("sub-agent.claude-code");

// Spawn a session
const { sessionId } = await svc.createSession({
  cwd: "/absolute/path/to/project",
  model: "claude-opus-4-5",        // optional; defaults to claude CLI default
  initialPrompt: "List files in src/",
  extraEnv: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
});

// Send additional prompts
await svc.sendPrompt({ sessionId, prompt: "Explain the main entry point." });

// Read new output since the last call
const { lines } = await svc.getOutput({ sessionId, mode: "since-last" });

// Read all output buffered so far
const { lines: all } = await svc.getOutput({ sessionId, mode: "all" });

// Terminate
await svc.terminate({ sessionId });
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ELIZA_WORKSPACE_DIR` | — | Workspace root; `cwd` passed to `createSession` must be under this (or `ELIZA_STATE_DIR`, or process cwd). |
| `ELIZA_STATE_DIR` | — | State dir; used as workspace root fallback. |
| `ELIZA_SUB_AGENT_SESSIONS_DIR` | `~/.eliza/sub-agent-sessions` | Where session transcript directories are written. |
| `ELIZA_SUB_AGENT_SESSION_RETENTION_DAYS` | `30` | Age threshold for transcript pruning. |

`ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` must be supplied via `extraEnv` in `createSession` — they are not forwarded automatically from the parent environment.

## Sandbox smoke tests

See `sandbox/SMOKE.md` for manual verification steps confirming the macOS and Linux sandbox profiles block reads outside the workspace root.

## Development

```bash
bun run --cwd packages/plugin-sub-agent-claude-code build
bun run --cwd packages/plugin-sub-agent-claude-code typecheck
bun run --cwd packages/plugin-sub-agent-claude-code test
bun run --cwd packages/plugin-sub-agent-claude-code lint
```
