# @elizaos/plugin-agent-orchestrator

Canonical elizaOS plugin for spawning and orchestrating coding sub-agents via
the Agent Client Protocol (ACP), with workspace lifecycle, GitHub integration,
task history, and runtime-driven sub-agent routing.

## Purpose / role

This plugin adds a full coding-agent orchestration surface to any Eliza agent.
It spawns local coding agents (elizaos, pi-agent, opencode, codex, claude) as
ACP subprocesses, routes their terminal events back into the elizaOS runtime as
synthetic inbound messages, and manages the git workspace and GitHub issue
lifecycle that accompanies repo-hosted coding tasks.

Loaded by name: `@elizaos/plugin-agent-orchestrator`. Not default-enabled —
add it explicitly in the agent's plugin list. Services and actions are only
registered when `isLocalCodeExecutionAllowed()` AND terminal support is detected;
on sandboxed or store-distributed runtimes the plugin registers a single stub
action that surfaces a clean error.

## Plugin surface

### Actions (from `tasksAction` via `promoteSubactionsToActions`)

All are sub-operations of the single `TASKS` parent action:

| Sub-action name | Promoted action | Purpose |
|---|---|---|
| `create` | `TASKS_CREATE` | One-shot: spawn + prompt + return. Records origin metadata for routing. |
| `spawn_agent` | `TASKS_SPAWN_AGENT` | Start a long-lived ACP coding-agent session. Returns active session info. |
| `send` | `TASKS_SEND_TO_AGENT` | Send a follow-up prompt to a running session. |
| `stop_agent` | `TASKS_STOP_AGENT` | Cooperatively cancel and close a session. |
| `list_agents` | `TASKS_LIST_AGENTS` | List active and persisted sessions. |
| `cancel` | `TASKS_CANCEL` | Cancel an in-flight task, preserve history. |
| `history` | `TASKS_HISTORY` | Retrieve past task sessions. |
| `control` | `TASKS_CONTROL` | Lifecycle control: pause/resume/stop/continue/archive/reopen. |
| `share` | `TASKS_SHARE` | Share a task session. |
| `provision_workspace` | `TASKS_PROVISION_WORKSPACE` | Clone repo, create git worktree for a task. |
| `submit_workspace` | `TASKS_SUBMIT_WORKSPACE` | Commit, push, open PR for a workspace. |
| `manage_issues` | `TASKS_MANAGE_ISSUES` | GitHub issue create/list/get/update/comment/close/reopen/add_labels. |
| `archive` | `TASKS_ARCHIVE` | Archive a completed coding task. |
| `reopen` | `TASKS_REOPEN` | Reopen an archived task. |

### Providers

| Name | Purpose |
|---|---|
| `AVAILABLE_AGENTS` | Adapter inventory + raw ACP session list |
| `ACTIVE_SUB_AGENTS` | Cache-stable view of active routed sessions (structural fields only, no timestamps) |
| `ACTIVE_WORKSPACE_CONTEXT` | Live workspace/session state for the planner |
| `CODING_AGENT_EXAMPLES` | Structured action-call examples injected into planner context |
| `CODING_SESSION_CHANGES` | Real git changeset for "show me the diff" queries |

### Services

| Class | `serviceType` | Purpose |
|---|---|---|
| `AcpService` | `ACP_SUBPROCESS_SERVICE` | ACP subprocess lifecycle, session state, event emission, transport selection |
| `OrchestratorTaskService` | `ORCHESTRATOR_TASK_SERVICE` | Durable task store, sub-agent lifecycle API, event bridge from ACP to task records |
| `SubAgentRouter` | `ACPX_SUB_AGENT_ROUTER` | Subscribes to AcpService events, routes terminal events into the runtime as synthetic memories |
| `CodingWorkspaceService` | `CODING_WORKSPACE_SERVICE` | Git workspace lifecycle (clone, branch, commit, push, PR) |

### Evaluator

- `subAgentCompletionResponseEvaluator` — `ResponseHandlerEvaluator` that fires when a `task_complete` event is received via a synthetic sub-agent memory; synthesizes a planner-ready completion summary turn.

### HTTP routes (registered via `register-routes.ts` side-effect)

All under the elizaOS runtime HTTP server:

| Path prefix | Handler | Purpose |
|---|---|---|
| `/api/orchestrator/*` | `handleOrchestratorRoutes` | Durable task CRUD, lifecycle, event log, usage rollup |
| `/api/coding-agents/*` | `handleAgentRoutes` | ACP session CRUD: list, spawn, get, send, stop, output |
| `/api/coding-agents/:id/credentials/*` | `handleBridgeRoutes` | Credential bridge (request + long-poll redemption) for spawned sub-agents |
| `/api/coding-agents/:id/context` | `handleParentContextRoutes` | Read-only parent-context bridge: memory, workspace state |
| `/api/workspace/*` | `handleWorkspaceRoutes` | Git workspace: provision, status, commit, push, PR, delete |
| `/api/task-agents/*` | (aliased to `/api/coding-agents/*`) | Legacy path alias |

### Events

- Listens to `EventType.MESSAGE_RECEIVED` (forwarding live user messages to the active sub-agent for the same roomId).
- Emits `TASK_AUDIT_EVENT` to persist append-only audit log entries.
- Wraps `runtime.sendMessageToTarget` to redirect planner replies into the per-task thread when thread support is available.

## Layout

```
plugins/plugin-agent-orchestrator/
  src/
    index.ts                     Plugin factory (createAgentOrchestratorPlugin),
                                 progress hook (registerProgressHook), exports
    register-routes.ts           Side-effect: registers HTTP routes with the runtime
    setup-routes.ts              Route wiring helpers
    actions/
      tasks.ts                   TASKS parent action + all sub-action runners
      common.ts                  Shared action helpers (getAcpService, labelFor, etc.)
      elizaos-capability.ts      elizaOS-specific capability action
      sandbox-stub.ts            Stub actions for sandboxed/no-terminal runtimes
    providers/
      available-agents.ts        AVAILABLE_AGENTS provider
      active-sub-agents.ts       ACTIVE_SUB_AGENTS provider
      active-workspace-context.ts ACTIVE_WORKSPACE_CONTEXT provider
      action-examples.ts         CODING_AGENT_EXAMPLES provider
      coding-session-changes.ts  CODING_SESSION_CHANGES provider
    evaluators/
      sub-agent-completion.ts    ResponseHandlerEvaluator for task_complete events
    services/
      acp-service.ts             AcpService — subprocess lifecycle, session store,
                                 transport selection (native vs cli)
      acp-native-transport.ts    NativeAcpClient (ACP JSON-RPC over stdio)
      sub-agent-router.ts        SubAgentRouter service — terminal event → synthetic memory
      orchestrator-task-service.ts OrchestratorTaskService — durable task lifecycle
      orchestrator-task-store.ts Task persistence (DB or JSON file)
      orchestrator-task-mapper.ts DTOs: TaskThreadDto, TaskThreadDetailDto
      orchestrator-task-types.ts  Type definitions for durable tasks
      workspace-service.ts       CodingWorkspaceService — delegates to sub-modules
      workspace-lifecycle.ts     GC, scratch dir cleanup
      workspace-git-ops.ts       Status, commit, push, PR creation
      workspace-github.ts        GitHub issue management, OAuth, PAT auth
      session-store.ts           AcpSessionStore / RuntimeDbSessionStore /
                                 FileSessionStore / InMemorySessionStore
      types.ts                   AgentType, SessionStatus, SessionEventName,
                                 SpawnOptions, SessionInfo, etc.
      config-env.ts              Reads all env vars into a typed config object
      task-agent-routing.ts      Adapter/workdir resolution for spawn routing
      task-agent-frameworks.ts   Framework state helpers
      task-policy.ts             ACL: requireTaskAgentAccess
      terminal-capabilities.ts   detectOrchestratorTerminalSupport
      skill-manifest.ts          Skill manifest generation
      skill-recommender.ts       Skill recommendation service
      ansi-utils.ts              ANSI escape stripping for terminal output
      spawn-trajectory.ts        Trajectory capture for spawned sessions
      parent-agent-broker.ts     Parent-agent context broker
      skill-lifeops-context-broker.ts LifeOps context broker for skills
    api/
      routes.ts                  Top-level route dispatcher
      agent-routes.ts            /api/coding-agents/* handlers
      orchestrator-routes.ts     /api/orchestrator/* handlers
      bridge-routes.ts           /api/coding-agents/:id/credentials/* handlers
      parent-context-routes.ts   /api/coding-agents/:id/context handlers
      workspace-routes.ts        /api/workspace/* handlers
      issue-routes.ts            /api/issues/* handlers (GitHub issue CRUD)
      route-utils.ts             parseBody, sendJson, sendError, RouteContext
  index.ts                      Re-export barrel (ESM root)
  index.node.ts                 Node-specific entry
```

## Commands

```bash
bun run --cwd plugins/plugin-agent-orchestrator build       # Build Node ESM + CJS + .d.ts
bun run --cwd plugins/plugin-agent-orchestrator dev         # Watch mode rebuild
bun run --cwd plugins/plugin-agent-orchestrator typecheck   # Type-check without emit
bun run --cwd plugins/plugin-agent-orchestrator test        # Run vitest suite
bun run --cwd plugins/plugin-agent-orchestrator test:unit   # Unit tests only
bun run --cwd plugins/plugin-agent-orchestrator test:e2e:manual  # acpx+codex smoke (requires installed acpx)
bun run --cwd plugins/plugin-agent-orchestrator lint        # Biome check + write
bun run --cwd plugins/plugin-agent-orchestrator lint:check  # Biome check only
bun run --cwd plugins/plugin-agent-orchestrator format      # Biome format + write
bun run --cwd plugins/plugin-agent-orchestrator clean       # Remove dist/.turbo/tsconfig artifacts
```

## Config / env vars

All are optional unless noted. Read by `src/services/config-env.ts` and
`src/services/acp-service.ts`.

| Variable | Default | Purpose |
|---|---|---|
| `ELIZA_ACP_TRANSPORT` | `native` | Transport: `native` (embedded JSON-RPC) or `cli`/`acpx` (legacy shell wrapper) |
| `ELIZA_ACP_CLI` | `acpx` | Path/command for the CLI transport |
| `ELIZA_ACP_DEFAULT_AGENT` | `elizaos` | Default agent type: `elizaos`, `pi-agent`, `opencode` |
| `ELIZA_DEFAULT_AGENT_TYPE` | `elizaos` | Compatibility alias for `ELIZA_ACP_DEFAULT_AGENT` |
| `ELIZA_AGENT_SELECTION_STRATEGY` | `fixed` | Adapter selection policy: `fixed` or `dynamic` |
| `ELIZA_ELIZAOS_ACP_COMMAND` | `elizaos` | Native elizaOS ACP command |
| `ELIZA_PI_AGENT_ACP_COMMAND` | `pi-agent` | Native Pi Agent ACP command |
| `ELIZA_CODEX_ACP_COMMAND` | `npx -y @zed-industries/codex-acp@0.14.0` | Native Codex ACP command |
| `ELIZA_CLAUDE_ACP_COMMAND` | `npx -y @agentclientprotocol/claude-agent-acp@0.34.0` | Native Claude ACP command |
| `ELIZA_OPENCODE_ACP_COMMAND` | bundled shim or `opencode acp` | Native OpenCode ACP command |
| `ELIZA_ACP_FORMAT` | `json` | ACP event format for legacy transports |
| `ELIZA_ACP_MAX_SESSIONS` | `8` | Concurrent session cap |
| `ELIZA_ACP_STATE_DIR` | `~/.eliza/plugin-acp` | Session state persistence dir when no runtime DB |
| `ACPX_DEFAULT_TIMEOUT_MS` | `300000` | Per-prompt timeout in ms |
| `ACPX_APPROVE_ALL` | `false` | When `true`, defaults sessions to approve-all preset |
| `ACPX_NO_TERMINAL` | `true` | Pass `--no-terminal` so agents use ACP events, not terminal UI |
| `ACPX_DEFAULT_CWD` | runtime cwd | Default working directory for ACP sessions |
| `ACPX_FORMAT` | `json` | Deprecated alias for `ELIZA_ACP_FORMAT` |
| `ACPX_SUB_AGENT_ROUTER_DISABLED` | unset | Set to `1` to keep SubAgentRouter registered but unbound |
| `ACPX_SUB_AGENT_ROUND_TRIP_CAP` | `32` | Per-session inject cap; force-stops ping-pong loops |
| `ACPX_PROGRESS_MODE` / `ELIZA_SUB_AGENT_PROGRESS_MODE` | `compact` | Progress UX: `compact`, `threaded`, or `silent` |
| `ACPX_PROGRESS_DELAY_MS` / `ELIZA_SUB_AGENT_PROGRESS_DELAY_MS` | `15000` | Delay before first progress post (ms) |
| `ACPX_PROGRESS_REACTIONS` / `ELIZA_SUB_AGENT_PROGRESS_REACTIONS` | unset | Set to `1` for emoji reactions in `threaded` mode |
| `ACP_AUDIT_LOG_PATH` | `~/.eliza/acp-audit.log` | Append-only audit log path |

## How to extend

**Add a new sub-action to TASKS:**
1. Add the sub-operation name to the `tasks` schema in `src/actions/tasks.ts`.
2. Implement a runner function that receives `(runtime, message, state, opts, cb)`.
3. Register it in the `switch` block of `tasksAction.handler`.
4. Export the standalone action alias from `src/index.ts` if external callers need it.

**Add a provider:**
1. Create `src/providers/<name>.ts` implementing `Provider` from `@elizaos/core`.
2. Import and add it to `orchestratorProviders` in `src/index.ts`.

**Add a service:**
1. Extend `Service` from `@elizaos/core` in `src/services/<name>.ts`.
2. Add it to `orchestratorServices` in `src/index.ts`.
3. Add it to the eager-start list in `init()` if it must be available before the first message.

**Add an HTTP route:**
1. Create or extend a handler module in `src/api/`.
2. Wire it into the dispatcher in `src/api/routes.ts` → `handleCodingAgentRoutes`.

## Conventions / gotchas

- **Node-only.** `package.json` `eliza.platforms` = `["node"]`. The plugin spawns
  child processes and uses `node:child_process`; it cannot run in a browser
  runtime or mobile.
- **Gated by `isLocalCodeExecutionAllowed()` AND terminal support.**
  `detectOrchestratorTerminalSupport()` returns false in sandboxed/store-distributed
  contexts. In those cases the plugin registers only the stub action; services and
  providers are skipped entirely.
- **Service eager-start.** `init()` defers service startup via `setTimeout(0)` then
  calls `runtime.getServiceLoadPromise` for each service type. Without this, the
  first TASKS call hits `runtime.getService()` before services are registered.
- **`sendMessageToTarget` wrap.** The progress hook wraps `runtime.sendMessageToTarget`
  to redirect planner replies into the per-task thread. The wrapper is removed in
  `dispose()`. A `__orchestratorSendWrapped` marker prevents double-wrapping.
- **Session persistence is tiered.** `RuntimeDbSessionStore` → `FileSessionStore`
  → `InMemorySessionStore`. The in-memory fallback logs a warning and sessions
  don't survive restart.
- **`ACPX_SUB_AGENT_ROUND_TRIP_CAP`** (default 32) force-stops runaway sub-agent
  loops. Lower it in test environments.
- **`coding-agent-adapters`** is the adapter registry/API dependency, not a bundled
  executable. The Codex and Claude CLI adapters are consumed via pinned `npx`
  commands unless deployment config overrides them.
- **`git-workspace-service`** is a peer dependency (version `0.4.5`). It must be
  installed alongside this plugin.
- **Route registration side-effect.** `register-routes.ts` is re-exported as
  `codingAgentRouteRegistration` from `index.ts` to prevent Bun's tree-shaker
  from dropping it. Do not convert it back to a bare side-effect import.
- See the root `AGENTS.md` for repo-wide rules (logger-only, ESM, architecture
  commandments, naming).
