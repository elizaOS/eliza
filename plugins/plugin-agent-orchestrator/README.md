# @elizaos/plugin-agent-orchestrator

[![npm version](https://img.shields.io/npm/v/@elizaos/plugin-agent-orchestrator.svg)](https://www.npmjs.com/package/@elizaos/plugin-agent-orchestrator)
[![CI](https://github.com/elizaos/eliza/actions/workflows/ci.yml/badge.svg)](https://github.com/elizaos/eliza/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The canonical orchestration plugin for ElizaOS task agents. Spawns local coding agents (elizaos, pi-agent, opencode, codex, claude) through Agent Client Protocol transports, routes their output back through the runtime so the main agent decides what to do, and bundles workspace lifecycle, GitHub PR integration, task share, and supporting services in a single package.

> Naming: this plugin is *not* the same thing as `@elizaos/plugin-acp`. That package is Shaw's ACP gateway client (IDE bridge over a remote ACP gateway). `@elizaos/plugin-agent-orchestrator` is the *task backend* that runs coding agents as subprocesses on the same host as the runtime.

## What it does

The plugin combines three concerns:

1. **Spawn** coding agents via ACP. The default path embeds ACP JSON-RPC session management in this plugin and talks directly to an ACP-compatible agent process; the legacy path can still shell out to [`acpx`](https://github.com/openclaw/acpx) when `ELIZA_ACP_TRANSPORT=cli`.
2. **Route** sub-agent terminal events (`task_complete`, `error`, `blocked`) and swarm coordination events back into the runtime as synthetic inbound messages addressed to the task room, worktree room, or original `roomId`/`userId`/`messageId`. The main agent's normal action layer then decides whether to `REPLY` to the user, `SEND_TO_AGENT` to push the sub-agent further, ask the task creator a question, or coordinate with other agents. See [`docs/sub-agent-routing.md`](./docs/sub-agent-routing.md).
3. **Coordinate** workspace lifecycle (clone, branch, commit, push, PR open) and GitHub issue management for repo-hosted tasks.

## Installation

```bash
npm install @elizaos/plugin-agent-orchestrator
```

Native TypeScript ACP is the default transport. Set the default coding agent with `ELIZA_ACP_DEFAULT_AGENT` (`elizaos`, `pi-agent`, or `opencode` are the primary supported defaults):

```bash
export ELIZA_ACP_TRANSPORT=native
export ELIZA_ACP_DEFAULT_AGENT=elizaos
export ELIZA_ELIZAOS_ACP_COMMAND="elizaos"
export ELIZA_PI_AGENT_ACP_COMMAND="pi-agent"
export ELIZA_CODEX_ACP_COMMAND="npx -y @zed-industries/codex-acp@0.14.0"
export ELIZA_CLAUDE_ACP_COMMAND="npx -y @agentclientprotocol/claude-agent-acp@0.34.0"
```

Authenticate the underlying agent you plan to use before spawning sessions. Native Codex and Claude defaults use `npx`, so pin or replace those commands in production if you do not want runtime downloads.

The legacy command-wrapper path remains available for compatibility:

```bash
npm install -g acpx@latest
export ELIZA_ACP_TRANSPORT=cli
```

Adapter packaging decision: this release does not vendor the Codex or Claude ACP adapter packages. Native transport is the default; Codex and Claude use pinned `npx` commands unless deployment config overrides them. OpenCode is the exception: the package prefers the bundled OpenCode shim when available, then falls back to `opencode acp`.

`coding-agent-adapters` is a runtime registry/API dependency used by this plugin's agent inventory and routes; it is not a bundled Codex or Claude ACP adapter executable.

## Quick start

```ts
import agentOrchestratorPlugin from "@elizaos/plugin-agent-orchestrator";

export default {
  plugins: [agentOrchestratorPlugin],
};
```

## Action surface

| Action | Purpose |
| --- | --- |
| `ACPX_CREATE_TASK` (`CREATE_TASK`) | One-shot: spawn + prompt + return. Captures origin metadata for routing. |
| `SPAWN_AGENT` | Start a long-lived ACP coding-agent session. Returns `data.agents[]`. |
| `SEND_TO_AGENT` | Send a follow-up prompt to a running session. The main agent uses this to push a sub-agent further when its proof is unsatisfying. |
| `STOP_AGENT` | Cooperatively cancel + close a session. |
| `LIST_AGENTS` | List active and persisted sessions. |
| `CANCEL_TASK` | Cancel an in-flight task while preserving history. |
| `TASK_HISTORY` / `TASK_CONTROL` / `TASK_SHARE` | ACP session lifecycle and sharing helpers. |
| `PROVISION_WORKSPACE` / `FINALIZE_WORKSPACE` | Git workspace setup, commit, push, PR open. |
| `MANAGE_ISSUES` | GitHub issue create/list/update/close. |

## Providers

- `AVAILABLE_AGENTS` — adapter inventory + raw session list.
- `ACTIVE_SUB_AGENTS` — cache-stable view of currently-routed sub-agent sessions; sorted by sessionId, structural fields only (no timestamps, no message excerpts), so the planner-visible block stays cached across status flips.
- `ACTIVE_WORKSPACE_CONTEXT` — live workspace/session state.
- `CODING_AGENT_EXAMPLES` — structured action call examples.

## Services

- `AcpService` — ACP subprocess lifecycle, session state, event emission, and transport selection. Registers under `ACP_SUBPROCESS_SERVICE`.
- `SubAgentRouter` (canonical) — subscribes to `AcpService.onSessionEvent`, posts terminal-event synthetic memories to `runtime.messageService.handleMessage`. Per-session round-trip cap (`ACPX_SUB_AGENT_ROUND_TRIP_CAP`, default 32) force-stops runaway loops. Disable with `ACPX_SUB_AGENT_ROUTER_DISABLED=1`.
- `CodingWorkspaceService` — git workspace lifecycle helpers.

```ts
import { AcpService, SubAgentRouter } from "@elizaos/plugin-agent-orchestrator";

const acp = runtime.getService("ACP_SUBPROCESS_SERVICE") as AcpService;

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

All configuration is via environment variables. Use `ELIZA_ACP_TRANSPORT=native` for the embedded TypeScript ACP client and `ELIZA_ACP_TRANSPORT=cli` only when you deliberately want the existing `acpx` wrapper.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ELIZA_ACP_TRANSPORT` | `native` | Transport mode. Accepted values include `native`/`direct` and `cli`/`acpx`. |
| `ELIZA_ACP_CLI` | `acpx` | ACPX executable name or absolute path for the CLI transport. |
| `ELIZA_ACP_DEFAULT_AGENT` | `elizaos` | Default agent type. Primary choices: `elizaos`, `pi-agent`, `opencode`. |
| `ELIZA_ELIZAOS_ACP_COMMAND` | `elizaos` | Native ElizaOS ACP command. |
| `ELIZA_PI_AGENT_ACP_COMMAND` | `pi-agent` | Native Pi Agent ACP command. |
| `ELIZA_CODEX_ACP_COMMAND` | `npx -y @zed-industries/codex-acp@0.14.0` | Native Codex ACP command. |
| `ELIZA_CLAUDE_ACP_COMMAND` | `npx -y @agentclientprotocol/claude-agent-acp@0.34.0` | Native Claude ACP command. |
| `ELIZA_OPENCODE_ACP_COMMAND` | bundled shim or `opencode acp` | Native OpenCode ACP command override. |
| `ELIZA_ACP_DEFAULT_APPROVAL` | `autonomous` | Approval preset (`read-only`, `auto`, `permissive`, `autonomous`, `full-access`). |
| `ELIZA_ACP_PROMPT_TIMEOUT_MS` / `ACPX_DEFAULT_TIMEOUT_MS` | `1800000` (30m) | Per-prompt timeout. |
| `ELIZA_ACP_STATE_DIR` | `~/.eliza/plugin-acp` | Where to persist session state when no runtime DB. |
| `ACPX_DEFAULT_CWD` | runtime cwd | Base directory for spawned agent workdirs. |
| `ELIZA_ACP_MAX_SESSIONS` | `8` | Concurrent session cap. |
| `ACPX_SUB_AGENT_ROUTER_DISABLED` | unset | Set to `1` to keep the router service registered but unbound (test/staging). |
| `ACPX_SUB_AGENT_ROUND_TRIP_CAP` | `32` | Per-session inject cap before force-stop to prevent ping-pong loops. |
| `ACPX_PROGRESS_MODE` / `ELIZA_SUB_AGENT_PROGRESS_MODE` | `compact` | Sub-agent progress UX: `compact` delays and edits one status message, `threaded` preserves per-task threads, `silent` disables visible progress. |
| `ACPX_PROGRESS_DELAY_MS` / `ELIZA_SUB_AGENT_PROGRESS_DELAY_MS` | `15000` | Delay before the first visible progress message, so short tasks only show the final answer. |
| `ACPX_PROGRESS_REACTIONS` / `ELIZA_SUB_AGENT_PROGRESS_REACTIONS` | unset | Set to `1` to add progress reactions in `threaded` mode. |

### Native transport status

Native transport is an ACP JSON-RPC client. It currently handles `initialize`, `session/new`, `session/prompt`, cooperative `session/cancel`, `session/close`, file reads/writes scoped to the session workspace, permission requests, and basic terminal requests from the agent.

Use the CLI transport only when you need the existing `acpx` command wrapper semantics.

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

# Native ACP adapter smoke (gated, no-op unless enabled):
RUN_LIVE_NATIVE_ACP=1 bun run test:e2e:native
```

`acp-codex-smoke.mjs` exercises the legacy `acpx` path by spawning a real codex session, sending "what is 7 + 8?", and verifying `task_complete` fires with response `"15"`. The vitest live test (`__tests__/live/sub-agent-router.live.test.ts`) verifies the synthetic Memory routes back from a real subprocess into a test `messageService.handleMessage` with all routing keys intact. Both no-op (skip) when `acpx` isn't installed.

`live-native-acp-smoke.mjs` sets `ELIZA_ACP_TRANSPORT=native`, starts a native ACP adapter over stdio, sends a tiny math prompt, and verifies the prompt response ended with `stopReason: "end_turn"` and final text containing `15`. Optional providers require explicit commands:

```bash
RUN_LIVE_NATIVE_ACP=1 LIVE_NATIVE_ACP_AGENT=claude ELIZA_CLAUDE_ACP_COMMAND="npx -y @agentclientprotocol/claude-agent-acp@0.34.0" bun run test:e2e:native
RUN_LIVE_NATIVE_ACP=1 LIVE_NATIVE_ACP_AGENT=opencode ELIZA_OPENCODE_ACP_COMMAND="opencode acp" bun run test:e2e:native
```

The native smoke skips successfully when `RUN_LIVE_NATIVE_ACP` is unset, when an optional provider command is not configured, or when the adapter reports missing authentication/credentials. Use `RUN_LIVE_NATIVE_ACP=1 bun run test -- __tests__/live/native-acp-smoke.live.test.ts` to run the same smoke through Vitest.

Native transport is covered by unit tests under `__tests__/unit/acp-native-transport.test.ts` and by the gated live smoke above.

## Package scripts

| Script | Purpose |
| --- | --- |
| `bun run build` / `bun run build:ts` | Build Node ESM, CJS, and declaration outputs. |
| `bun run dev` | Rebuild in watch mode. |
| `bun run typecheck` | Run TypeScript without emitting files. |
| `bun run test` | Run the plugin vitest suite. |
| `bun run test:unit` | Run unit tests only. |
| `bun run test:e2e:manual` | Run the manual `acp-codex-smoke.mjs` smoke against installed/authenticated `acpx` + Codex. |
| `bun run test:e2e:native` | Run the gated native ACP adapter smoke when `RUN_LIVE_NATIVE_ACP=1`. |
| `bun run lint:check` | Run Biome checks without writing changes. |
| `bun run lint` | Run Biome checks with write/unsafe fixes. |
| `bun run format:check` | Check formatting. |
| `bun run format` | Write formatting changes. |
| `bun run clean` | Remove local build/cache outputs. |

## Status

`2.0.0-beta.2` — package. ACP subprocess sessions are the only task-agent spawn path. The native ACP client is available behind `ELIZA_ACP_TRANSPORT=native`.

## Contributing

PRs welcome. Run `npm run typecheck && npm test` before opening.

## License

MIT. See [LICENSE](./LICENSE).
