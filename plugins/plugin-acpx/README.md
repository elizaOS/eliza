# @elizaos/plugin-acpx

[![npm version](https://img.shields.io/npm/v/@elizaos/plugin-acpx.svg)](https://www.npmjs.com/package/@elizaos/plugin-acpx)
[![CI](https://github.com/elizaos/eliza/actions/workflows/ci.yml/badge.svg)](https://github.com/elizaos/eliza/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An **acpx-backed task and subagent plugin** for ElizaOS. It wraps the [`acpx`](https://github.com/0xouroboros/acp) CLI to spawn local coding agents (codex, claude, gemini, ...) as background sessions and exposes them through ElizaOS actions. Drop-in compatible with `@elizaos/plugin-agent-orchestrator`'s action surface, but uses structured Agent Client Protocol (ACP) events under the hood instead of PTY scraping.

> Naming: this plugin is *not* the same thing as `@elizaos/plugin-acp`. That package is Shaw's ACP gateway client (IDE bridge over a remote ACP gateway). `@elizaos/plugin-acpx` is the *task backend* that uses `acpx` to run coding agents as subprocesses on the same host as the runtime.

## Why

`plugin-agent-orchestrator` runs each coding agent (codex, claude, gemini, ...) inside a pseudo-terminal and parses ANSI escape codes, prompt regexes, and stall heuristics. It works, but it inherits every quirk of every agent's terminal UI.

`plugin-acpx` swaps the transport: it spawns each agent through `acpx`, which speaks the [Agent Client Protocol](https://agentclientprotocol.com/) and emits a typed JSON-RPC stream:

- structured `tool_call` / `tool_call_update` events instead of ANSI scraping
- cooperative cancellation via `session/cancel`
- crash recovery via `session/load`
- parallel sessions in the same workspace
- `agent_message_chunk` for streaming text instead of pty buffer reads
- works for codex, claude, gemini today; cursor/copilot/droid/qwen via acpx 0.7+

The plugin keeps the same action names so existing flows continue to work.

## Installation

```bash
npm install @elizaos/plugin-acpx
npm install -g acpx@latest
acpx --version
```

You also need at least one ACP-compatible agent CLI installed (`codex`, `claude`, or `gemini`) and authenticated.

## Quick start

```ts
import acpPlugin from "@elizaos/plugin-acpx";

export default {
  plugins: [acpPlugin],
};
```

Once loaded, the plugin registers `AcpxSubprocessService` (`AcpService` for short, also aliased as `PTY_SERVICE` for back-compat with `plugin-agent-orchestrator` consumers), six actions, and one provider.

## Actions

| Action | Purpose |
| --- | --- |
| `SPAWN_AGENT` | Start a long-lived acpx coding-agent session. Returns `data.agents[]`. |
| `SEND_TO_AGENT` | Send a prompt to a running session, await completion. |
| `LIST_AGENTS` | List active and persisted sessions. |
| `STOP_AGENT` | Cooperatively cancel + close a session. |
| `CREATE_TASK` | One-shot: spawn + prompt + return. Used by nyx-style task agents. |
| `CANCEL_TASK` | Cancel an in-flight task. |

`CREATE_TASK` returns a shape compatible with `plugin-agent-orchestrator`:

```ts
{
  data: {
    agents: [{ id, sessionId, agentType, name, workdir }],
  },
  text: "...",
}
```

## Provider

`availableAgentsProvider` exposes installed/auth-status/agent-type info to the runtime state, so the model can pick the right agent type at call time.

## Service

`AcpxSubprocessService` (exported as `AcpService` for short) is the core. It wraps acpx subprocess lifecycle, NDJSON parsing, session state, and event emission.

```ts
import { AcpService } from "@elizaos/plugin-acpx";

const acp = runtime.getService("PTY_SERVICE") as AcpService;
// or: runtime.getService("ACP_SERVICE") as AcpService;

const { sessionId } = await acp.spawnSession({
  agentType: "codex",
  workdir: "/tmp/my-task",
  approvalPreset: "permissive",
});

const result = await acp.sendPrompt(sessionId, "what is 7 + 8?");
console.log(result.finalText);     // "15"
console.log(result.stopReason);    // "end_turn"
console.log(result.durationMs);    // 4864
```

### Subscribing to events

```ts
acp.onSessionEvent((sessionId, eventName, data) => {
  // eventName: "ready" | "message" | "tool_running" | "task_complete" | "stopped" | "error" | "blocked" | "login_required" | "reconnected"
  // data shape depends on eventName, see SessionEventName in src/services/types.ts
});
```

The `task_complete` event matches `plugin-agent-orchestrator`'s shape:

```ts
{ response: string, durationMs: number, stopReason: "end_turn" | "error" | string }
```

## Configuration

All configuration is via environment variables. Sensible defaults; most users only need `ELIZA_ACP_CLI` if `acpx` is not on `PATH`. The `ELIZA_ACP_*` prefix is named after the protocol; the package itself wraps the `acpx` CLI.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ELIZA_ACP_CLI` | `acpx` | ACPX executable name or absolute path. |
| `ELIZA_ACP_DEFAULT_AGENT` | `codex` | Default agent type. |
| `ELIZA_ACP_DEFAULT_APPROVAL` | `autonomous` | Approval preset (`read-only`, `auto`, `permissive`, `autonomous`, `full-access`). |
| `ELIZA_ACP_PROMPT_TIMEOUT_MS` | `1800000` (30m) | Per-prompt timeout. |
| `ELIZA_ACP_AUTH_TIMEOUT_MS` | `120000` | Auth handshake timeout. |
| `ELIZA_ACP_STATE_DIR` | `~/.eliza/plugin-acpx` | Where to persist session state when no runtime DB. |
| `ELIZA_ACP_WORKSPACE_ROOT` | runtime cwd | Base directory for spawned agent workdirs. |
| `ELIZA_ACP_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `ELIZA_ACP_MAX_SESSIONS` | unlimited | Concurrent session cap. |
| `ELIZA_ACP_REGISTER_AS_PTY_SERVICE` | `true` | Register service under `PTY_SERVICE` alias for back-compat. |

## Persistence

Session state is persisted with a tiered backend:

1. If `runtime.databaseAdapter` exposes SQL methods, sessions live in `acp_sessions` table.
2. Otherwise, JSON file at `$ELIZA_ACP_STATE_DIR/sessions.json` (atomic writes via temp+rename).
3. Last resort: in-memory `Map` (warns that sessions won't survive restart).

## End-to-end smoke test

The repo ships with a real e2e smoke at `tests/e2e/acp-codex-smoke.mjs`:

```bash
npm install -g acpx@latest
# authenticate codex first
npm run build
node tests/e2e/acp-codex-smoke.mjs
```

It spawns a real codex session, sends "what is 7 + 8?", and verifies `task_complete` fires with response `"15"`. Useful as a sanity check before integrating into a real runtime.

## Compatibility with `@elizaos/plugin-agent-orchestrator`

You can run both plugins side-by-side. The actions don't conflict by name; they are dispatched by description matching, not name collision. To make `runtime.getService("PTY_SERVICE")` return the acpx subprocess service, set `ELIZA_ACP_REGISTER_AS_PTY_SERVICE=true` (default) and don't load `plugin-agent-orchestrator`. To use both, set `ELIZA_ACP_REGISTER_AS_PTY_SERVICE=false` and let the orchestrator own the `PTY_SERVICE` alias.

## Status

`0.1.0`. Alpha, but every layer is implemented and tested:

- 9 test files, 38 unit tests, 100% passing
- real e2e smoke against `acpx` + codex passes
- nyx-compatible `CREATE_TASK` + `PTY_SERVICE` alias

What's deferred to later versions:

- `provision_workspace` / `finalize_workspace` (use git directly for now)
- `manage_issues` / GitHub integration
- swarm-coordinator (sibling-to-sibling agent comms)
- aider, pi, replit-agent (waiting for acpx coverage)

## Contributing

PRs welcome. Run `npm run typecheck && npm test` before opening.

## License

MIT. See [LICENSE](./LICENSE).
