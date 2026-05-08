# @elizaos/plugin-agent-orchestrator

[![npm version](https://img.shields.io/npm/v/@elizaos/plugin-agent-orchestrator.svg)](https://www.npmjs.com/package/@elizaos/plugin-agent-orchestrator)
[![CI](https://github.com/elizaos/eliza/actions/workflows/ci.yml/badge.svg)](https://github.com/elizaos/eliza/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The canonical orchestration plugin for ElizaOS task agents. Spawns local coding agents (codex, claude, gemini, ...) via the [`acpx`](https://github.com/0xouroboros/acp) CLI using the structured Agent Client Protocol, routes their output back through the runtime so the main agent decides what to do, and bundles workspace lifecycle, GitHub PR integration, task share, and supporting services in a single package.

> Naming: this plugin is *not* the same thing as `@elizaos/plugin-acp`. That package is Shaw's ACP gateway client (IDE bridge over a remote ACP gateway). `@elizaos/plugin-agent-orchestrator` is the *task backend* that uses `acpx` to run coding agents as subprocesses on the same host as the runtime.

## What it does

The plugin combines three previously-separate concerns:

1. **Spawn** coding agents via ACP (canonical) or PTY (legacy). The ACP path uses typed JSON-RPC events instead of ANSI-escape scraping — `tool_call` / `tool_call_update`, `agent_message_chunk`, cooperative `session/cancel`, parallel sessions in the same workspace, recoverable via `session/load`.
2. **Route** sub-agent terminal events (`task_complete`, `error`, `blocked`) back into the runtime as synthetic inbound messages addressed to the original `roomId`/`userId`/`messageId`. The main agent's normal action layer then decides whether to `REPLY` to the user, `SEND_TO_AGENT` to push the sub-agent further, or both. See [`docs/sub-agent-routing.md`](./docs/sub-agent-routing.md).
3. **Coordinate** workspace lifecycle (clone, branch, commit, push, PR open) and GitHub issue management for repo-hosted tasks.

## Installation

```bash
npm install @elizaos/plugin-agent-orchestrator
npm install -g acpx@latest
acpx --version
```

You also need at least one ACP-compatible agent CLI (`codex`, `claude`, or `gemini`) installed and authenticated.

## Quick start

```ts
import agentOrchestratorPlugin from "@elizaos/plugin-agent-orchestrator";

export default {
  plugins: [agentOrchestratorPlugin],
};
```

`taskAgentPlugin`, `codingAgentPlugin`, and `acpPlugin` are aliases for the same default export.

## Action surface

| Action | Purpose |
| --- | --- |
| `ACPX_CREATE_TASK` (`CREATE_TASK`) | One-shot: spawn + prompt + return. Captures origin metadata for routing. |
| `SPAWN_AGENT` | Start a long-lived ACP coding-agent session. Returns `data.agents[]`. |
| `SEND_TO_AGENT` | Send a follow-up prompt to a running session. The main agent uses this to push a sub-agent further when its proof is unsatisfying. |
| `STOP_AGENT` | Cooperatively cancel + close a session. |
| `LIST_AGENTS` | List active and persisted sessions. |
| `CANCEL_TASK` | Cancel an in-flight task while preserving history. |
| `TASK_HISTORY` / `TASK_CONTROL` / `TASK_SHARE` | Task lifecycle ops over the coordinator surface. |
| `PROVISION_WORKSPACE` / `FINALIZE_WORKSPACE` | Git workspace setup, commit, push, PR open. |
| `MANAGE_ISSUES` | GitHub issue create/list/update/close. |

## Providers

- `AVAILABLE_AGENTS` — adapter inventory + raw session list.
- `ACTIVE_SUB_AGENTS` — cache-stable view of currently-routed sub-agent sessions; sorted by sessionId, structural fields only (no timestamps, no message excerpts), so the planner-visible block stays cached across status flips.
- `ACTIVE_WORKSPACE_CONTEXT` — live workspace/session state.
- `CODING_AGENT_EXAMPLES` — structured action call examples.

## Services

- `AcpService` (canonical) — ACP subprocess lifecycle, NDJSON parsing, session state, event emission. Registers under both `ACP_SUBPROCESS_SERVICE` and (for back-compat) `PTY_SERVICE` unless `ELIZA_ACP_REGISTER_AS_PTY_SERVICE=false`.
- `SubAgentRouter` (canonical) — subscribes to `AcpService.onSessionEvent`, posts terminal-event synthetic memories to `runtime.messageService.handleMessage`. Per-session round-trip cap (`ACPX_SUB_AGENT_ROUND_TRIP_CAP`, default 32) force-stops runaway loops. Disable with `ACPX_SUB_AGENT_ROUTER_DISABLED=1`.
- `PTYService` (legacy) — pre-ACP PTY-based spawn surface. Bound to `pty-manager`. Naturally dormant for ACP-spawned sessions; kept for callers that still depend on it.
- `CodingWorkspaceService` (legacy) — git workspace lifecycle helpers used by the PTY-era flow.

```ts
import { AcpService, SubAgentRouter } from "@elizaos/plugin-agent-orchestrator";

const acp = runtime.getService("ACP_SUBPROCESS_SERVICE") as AcpService;
// or: runtime.getService("PTY_SERVICE") as AcpService;

const { sessionId } = await acp.spawnSession({
  agentType: "codex",
  workdir: "/tmp/my-task",
  approvalPreset: "permissive",
  metadata: {
    roomId: message.roomId,
    userId: message.entityId,
    messageId: message.id,
    label: "fix bug 42",
  },
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

The `task_complete` event:

```ts
{ response: string, durationMs: number, stopReason: "end_turn" | "error" | string }
```

You usually don't subscribe directly — `SubAgentRouter` already does, and routes terminal events into the runtime. Subscribe only if you need raw access (e.g. dashboards).

## Configuration

All configuration is via environment variables. Sensible defaults; most users only need `ELIZA_ACP_CLI` if `acpx` is not on `PATH`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ELIZA_ACP_CLI` | `acpx` | ACPX executable name or absolute path. |
| `ELIZA_ACP_DEFAULT_AGENT` | `codex` | Default agent type. |
| `ELIZA_ACP_DEFAULT_APPROVAL` | `autonomous` | Approval preset (`read-only`, `auto`, `permissive`, `autonomous`, `full-access`). |
| `ELIZA_ACP_PROMPT_TIMEOUT_MS` / `ACPX_DEFAULT_TIMEOUT_MS` | `1800000` (30m) | Per-prompt timeout. |
| `ELIZA_ACP_AUTH_TIMEOUT_MS` | `120000` | Auth handshake timeout. |
| `ELIZA_ACP_STATE_DIR` | `~/.eliza/plugin-acpx` | Where to persist session state when no runtime DB. |
| `ELIZA_ACP_WORKSPACE_ROOT` / `ACPX_DEFAULT_CWD` | runtime cwd | Base directory for spawned agent workdirs. |
| `ELIZA_ACP_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `ELIZA_ACP_MAX_SESSIONS` | `8` | Concurrent session cap. |
| `ELIZA_ACP_REGISTER_AS_PTY_SERVICE` | `true` | Register `AcpService` under `PTY_SERVICE` alias for back-compat. |
| `ACPX_SUB_AGENT_ROUTER_DISABLED` | unset | Set to `1` to keep the router service registered but unbound (test/staging). |
| `ACPX_SUB_AGENT_ROUND_TRIP_CAP` | `32` | Per-session inject cap before force-stop to prevent ping-pong loops. |

## Persistence

Session state is persisted with a tiered backend:

1. If `runtime.databaseAdapter` exposes SQL methods, sessions live in the `acp_sessions` table.
2. Otherwise, JSON file at `$ELIZA_ACP_STATE_DIR/sessions.json` (atomic writes via temp+rename).
3. Last resort: in-memory `Map` (warns that sessions won't survive restart).

## End-to-end smoke tests

Two smokes ship with the repo:

```bash
# Raw AcpService against installed acpx + codex:
npm install -g acpx@latest
# authenticate codex first
npm run build
node tests/e2e/acp-codex-smoke.mjs

# Full router loop (vitest, gated):
RUN_LIVE_ACPX=1 bun run test
```

`acp-codex-smoke.mjs` spawns a real codex session, sends "what is 7 + 8?", and verifies `task_complete` fires with response `"15"`. The vitest live test (`__tests__/live/sub-agent-router.live.test.ts`) verifies the synthetic Memory routes back from a real subprocess into a fake `messageService.handleMessage` with all routing keys intact. Both no-op (skip) when `acpx` isn't installed.

## Status

`0.2.0` — consolidated package. Replaces the previous two-package split between the legacy `@elizaos/plugin-agent-orchestrator` (PTY + workspace) and `@elizaos/plugin-acpx` (ACP spawn). Aliases (`acpPlugin`, `taskAgentPlugin`, `codingAgentPlugin`) preserve back-compat for existing callers.

The PTY-based legacy services (`PTYService`, `SwarmCoordinator`, `swarm-decision-loop`, `pty-spawn`, `stall-classifier`, etc.) are still in the package and exported. They are dormant for ACP-spawned sessions but kept for callers that haven't migrated yet. Retiring them is a follow-up cleanup.

## Contributing

PRs welcome. Run `npm run typecheck && npm test` before opening.

## License

MIT. See [LICENSE](./LICENSE).
