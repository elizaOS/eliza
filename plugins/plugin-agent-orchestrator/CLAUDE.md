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
| `send` | `TASKS_SEND` | Send a follow-up prompt to a running session. (`SEND_TO_AGENT` is a simile.) |
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
| `/api/coding-agents/:id/{parent-context,memory,active-workspaces}` | `handleParentContextRoutes` | Read-only parent-context bridge: memory, workspace state |
| `/api/workspace/*` | `handleWorkspaceRoutes` | Git workspace: provision, status, commit, push, PR, delete |
| `/api/issues/*` | `handleIssueRoutes` | GitHub issue CRUD (separate from manage_issues action) |
| `/api/task-agents/*` | (aliased to `/api/coding-agents/*`) | Legacy path alias |

### Events

- Listens to `EventType.MESSAGE_RECEIVED` (forwarding live user messages to the active sub-agent for the same roomId).
- Emits `TASK_AUDIT_EVENT` to persist append-only audit log entries.
- Wraps `runtime.sendMessageToTarget` to redirect planner replies into the per-task thread when thread support is available.

## Device × backend × auth-mode support matrix

Coding-agent orchestration is gated per device by the same pure classifier the
runtime uses (`classifyTerminalSupport` / `detectOrchestratorTerminalSupport` in
`services/terminal-capabilities.ts`). The checked-in source of truth is
`ORCHESTRATOR_DEVICE_SUPPORT_MATRIX` (`services/orchestrator-device-support-matrix.ts`),
computed *through that classifier* so it cannot silently drift from the gate — a
gating change that affects any documented profile fails this package's tests
(`orchestrator-device-support-matrix.test.ts`). Do not hand-edit the matrix to
disagree with the classifier; change the classifier and let the matrix follow.
See issue #9146.

| Device profile | Supported? | Reason | Coding backends |
|---|---|---|---|
| Desktop / server (Node, non-store) | ✅ | — | all 5 |
| Android direct/AOSP local-yolo (staged shell) | ✅ | — | all 5 |
| iOS (vanilla mobile runtime) | ❌ | `vanilla_mobile` | none — stub action only |
| Store build (sandboxed distribution) | ❌ | `store_build` | none — stub action only |
| Android Play/store build (not local-yolo) | ❌ | `not_local_yolo` | none — stub action only |

Classifier precedence: `store_build` > `vanilla_mobile` (iOS) > `not_local_yolo`
(Android non-yolo) > missing staged shell. When a device is supported every
backend below is reachable; when unsupported only the stub action registers
(see "Gated by `isLocalCodeExecutionAllowed()` AND terminal support" below).

Topology decision (#9146): local coding-agent subprocess execution is a
host capability, not a per-client guarantee. Desktop/server Node runtimes and
Android direct/AOSP `local-yolo` builds may run the orchestrator locally. iOS,
Android Play/store, Mac App Store, and other sandboxed/store builds do not spawn
local coding CLIs; they should operate as remote controllers for a desktop/cloud
host orchestrator via the shared `/api/orchestrator/*` and
`/api/coding-agents/*` HTTP surfaces. Account selection, subscription token
materialization, and API-key dropping happen on that host, so web, desktop, and
Capacitor mobile clients all observe the same selected-account behavior when
they call the host APIs. Voice is in scope as an input modality: a voice turn
creates or messages the same orchestrator task/session, and the completion is
narrated by the normal task transcript/progress path rather than by a separate
voice-only scheduler.

Backend → auth-mode reach (`ORCHESTRATOR_BACKEND_AUTH`, mirroring
`AGENT_PROVIDER_CANDIDATES` in
`packages/app-core/src/services/coding-account-bridge.ts`; subscription is
preferred over API key):

| Backend | Auth modes (preferred → fallback) |
|---|---|
| `elizaos` | runtime-routed |
| `pi-agent` | runtime-routed |
| `claude` | anthropic-subscription → anthropic-api |
| `codex` | openai-codex → openai-api |
| `opencode` | cerebras-api |

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
      workspace-types.ts         Shared workspace type definitions
      workspace-diff.ts          Git diff utilities for workspace
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
      trajectory-context.ts      Trajectory context helpers
      trajectory-feedback.ts     Trajectory feedback processing
      parent-agent-broker.ts     Parent-agent context broker
      parent-agent-dispatch.ts   Dispatch helpers for parent-agent context
      skill-lifeops-context-broker.ts LifeOps context broker for skills
      agent-name-assignment.ts   Agent name assignment helpers
      audit.ts                   Audit log utilities (TASK_AUDIT_EVENT)
      coding-account-selection.ts Account/credential selection for spawned agents
      goal-llm-verifier.ts       LLM-based goal verification for task completion
      goal-prompt.ts             Goal prompt construction helpers
      interruption-decider.ts    Decides whether to interrupt a running sub-agent
      json-model-output.ts       Structured JSON output helpers for model calls
      opencode-config.ts         OpenCode-specific ACP configuration
      repo-input.ts              Repository input parsing and validation
      session-event-queue.ts     Per-session event queue for ordered delivery
      smithers-task-executor.ts  TaskStepExecutor impl — drives ACP turns per step
      smithers-task-integration.ts Integration layer; gates smithers via ELIZA_ORCHESTRATOR_SMITHERS
      smithers-task-runner.ts    High-level smithers task runner (provision→turn→submit loop)
      smithers-task-types.ts     Types for the smithers task execution model
      spend-allowance.ts         Per-session spend allowance / budget enforcement
      ssrf-guard.ts              SSRF protection for outbound URL fetches
      sub-agent-identity.ts      Sub-agent identity and credential helpers
      sub-agent-inbox.ts         Per-session message inbox for the interruption decider
      workdir-validation.ts      Working directory validation and sandboxing
    api/
      routes.ts                  Top-level route dispatcher
      agent-routes.ts            /api/coding-agents/* handlers
      orchestrator-routes.ts     /api/orchestrator/* handlers
      bridge-routes.ts           /api/coding-agents/:id/credentials/* handlers
      parent-context-routes.ts   /api/coding-agents/:id/{parent-context,memory,active-workspaces} handlers
      workspace-routes.ts        /api/workspace/* handlers
      issue-routes.ts            /api/issues/* handlers (GitHub issue CRUD)
      route-utils.ts             parseBody, sendJson, sendError, RouteContext
  index.ts                      Re-export barrel (ESM root)
  index.node.ts                 Node-specific entry
```

## Commands

```bash
bun run --cwd plugins/plugin-agent-orchestrator build           # Build Node ESM + CJS + .d.ts
bun run --cwd plugins/plugin-agent-orchestrator build:ts        # TypeScript-only build
bun run --cwd plugins/plugin-agent-orchestrator dev             # Watch mode rebuild
bun run --cwd plugins/plugin-agent-orchestrator typecheck       # Type-check without emit
bun run --cwd plugins/plugin-agent-orchestrator test            # Run vitest suite
bun run --cwd plugins/plugin-agent-orchestrator test:unit       # Unit tests only
bun run --cwd plugins/plugin-agent-orchestrator test:watch      # Vitest watch mode
bun run --cwd plugins/plugin-agent-orchestrator test:e2e:manual # acpx+codex smoke (requires installed acpx)
bun run --cwd plugins/plugin-agent-orchestrator test:e2e:multi-account  # Multi-account smoke test
bun run --cwd plugins/plugin-agent-orchestrator lint            # Biome check + write
bun run --cwd plugins/plugin-agent-orchestrator lint:check      # Biome check only
bun run --cwd plugins/plugin-agent-orchestrator format          # Biome format + write
bun run --cwd plugins/plugin-agent-orchestrator format:check    # Biome format check only
bun run --cwd plugins/plugin-agent-orchestrator clean           # Remove dist/.turbo/tsconfig artifacts
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
| `ELIZA_ELIZAOS_ACP_COMMAND` | `eliza-code-acp` | Native elizaOS ACP command |
| `ELIZA_PI_AGENT_ACP_COMMAND` | `pi-agent` | Native Pi Agent ACP command |
| `ELIZA_CODEX_ACP_COMMAND` | `npx -y @zed-industries/codex-acp@0.14.0` | Native Codex ACP command |
| `ELIZA_CODEX_ACP_SANDBOX_MODE` / `ELIZA_CODEX_SANDBOX_MODE` | unset | Optional Codex ACP `sandbox_mode` override: `read-only`, `workspace-write`, or `danger-full-access` |
| `ELIZA_CODEX_ACP_NO_LANDLOCK_SANDBOX_MODE` | `danger-full-access` | Codex ACP sandbox mode used when Linux Landlock is unavailable |
| `ELIZA_CODEX_ACP_APPROVAL_POLICY` / `ELIZA_CODEX_APPROVAL_POLICY` | `never` for no-Landlock fallback, otherwise unset | Optional Codex ACP `approval_policy` override |
| `ELIZA_CODEX_ACP_LANDLOCK` / `ELIZA_CODEX_LANDLOCK` | auto-detect | Force Landlock detection for containers/tests: `1`/`true` or `0`/`false` |
| `ELIZA_CLAUDE_ACP_COMMAND` | `npx -y @agentclientprotocol/claude-agent-acp@0.34.0` | Native Claude ACP command |
| `ELIZA_OPENCODE_ACP_COMMAND` | bundled shim or `opencode acp` | Native OpenCode ACP command |
| `ELIZA_ACP_MAX_SESSIONS` | `8` | Concurrent session cap |
| `ELIZA_MAX_SPAWNS_PER_ORIGIN` | `3` | Max sub-agent spawns per root user message before relaying the best captured result instead of re-spawning (bounds the weak-model re-spawn loop) |
| `ELIZA_ACP_STATE_DIR` | `~/.eliza/plugin-acp` | Session state persistence dir when no runtime DB |
| `ELIZA_ACP_SESSION_STORE_BACKEND` | unset | Override session store backend (`db`, `file`, or `memory`) |
| `ELIZA_ACP_MCP_SERVERS` | unset | JSON list of MCP servers to pass to spawned sub-agents |
| `ELIZA_MAX_CONCURRENT_SPAWNS` | unset | Cap on simultaneous spawn operations |
| `ELIZA_WORKSPACE_DIR` | unset | Default workspace root for provisioned coding workspaces |
| `ELIZA_CODING_DIRECTORY` | unset | Preferred directory for new coding tasks |
| `TASK_AGENT_WORKDIR_ROOTS` | unset | Colon-separated list of allowed workdir roots |
| `TASK_AGENT_WORKDIR_ROUTES` | unset | JSON routing rules mapping task labels to workdirs |
| `ELIZA_ORCHESTRATOR_SMITHERS` | `1` (enabled) | Set to `0` to disable the smithers task execution path and fall back to direct prompt |
| `ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY` | unset | Enable LLM-based goal verification on task completion |
| `ELIZA_REQUIRE_GOAL_CONTRACT` | `1` (enabled) | Auto-generate 3-5 measurable default acceptance criteria for a criteria-free, non-trivial task so the verifier always fires. Set to `0` to keep criteria-free tasks criteria-free (prior behavior). |
| `SMITHERS_DB_PROVIDER` | unset | Database provider for smithers task storage |
| `SMITHERS_DB_URL` | unset | Database URL for smithers task storage |
| `SMITHERS_DB_DATA_DIR` | unset | Data directory for smithers file-backed storage |
| `ELIZA_SCRATCH_RETENTION` | unset | How long to retain scratch workspace dirs |
| `ELIZA_SCRATCH_DECISION_TTL_MS` | unset | TTL for scratch workspace GC decisions |
| `ELIZA_CLOUD_API_KEY` / `ELIZAOS_CLOUD_API_KEY` | unset | Cloud API key forwarded to spawned sub-agents |
| `ELIZA_CLOUD_URL` / `ELIZAOS_CLOUD_URL` | unset | Cloud base URL forwarded to spawned sub-agents |
| `ACPX_DEFAULT_TIMEOUT_MS` | `300000` | Per-prompt timeout in ms |
| `ACPX_APPROVE_ALL` | `false` | When `true`, defaults sessions to approve-all preset |
| `ACPX_NO_TERMINAL` | `true` | Pass `--no-terminal` so agents use ACP events, not terminal UI |
| `ACPX_DEFAULT_CWD` | runtime cwd | Default working directory for ACP sessions |
| `ACPX_FORMAT` | `json` | ACP event format for the legacy CLI transport |
| `ACPX_SUB_AGENT_ROUTER_DISABLED` | unset | Set to `1` to keep SubAgentRouter registered but unbound |
| `ACPX_SUB_AGENT_ROUND_TRIP_CAP` | `32` | Per-session inject cap; force-stops ping-pong loops |
| `ACPX_PROGRESS_MODE` / `ELIZA_SUB_AGENT_PROGRESS_MODE` | `compact` | Progress UX: `compact`, `threaded`, or `silent` |
| `ACPX_PROGRESS_DELAY_MS` / `ELIZA_SUB_AGENT_PROGRESS_DELAY_MS` | `15000` | Delay before first progress post (ms) |
| `ACPX_PROGRESS_REACTIONS` / `ELIZA_SUB_AGENT_PROGRESS_REACTIONS` | unset | Set to `1` for emoji reactions in `threaded` mode |
| `ACP_AUDIT_LOG_PATH` | `~/.eliza/acp-audit.log` | Append-only audit log path |
| `ELIZA_MODEL_GATEWAY_URL` | unset | Model-gateway mode (#11536 E2): OpenAI/Anthropic-compatible base URL a spawned sub-agent is pointed at. ON only when both this and `_TOKEN` are set. |
| `ELIZA_MODEL_GATEWAY_TOKEN` | unset | Gateway credential injected into the sub-agent (as `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`) in place of raw provider keys. In lease mode this is the parent-only, mint-capable token — never forwarded to the child. |
| `ELIZA_MODEL_GATEWAY_LEASE_URL` | unset | Broker lease endpoint (#11536 E2 residual). When set (with gateway mode on), each spawn mints a per-spawn, TTL-bound, revocable lease (`POST` → `{ token, expiresAt, leaseId }`; revoke `POST <url>/<leaseId>/revoke`) and the child gets the leased token, not the static one. Unset ⇒ static-token fallback. |
| `ELIZA_MODEL_GATEWAY_STRICT` | unset | `1`/`true` fails a spawn closed rather than hand a sub-agent a static long-lived gateway token when a lease broker is expected but absent or the mint fails. |

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
- **Smithers task path.** By default (`ELIZA_ORCHESTRATOR_SMITHERS` not `0`), task
  execution goes through the smithers runner (`smithers-task-runner.ts`), which
  drives a structured provision→turn→submit loop. Set `ELIZA_ORCHESTRATOR_SMITHERS=0`
  to revert to the direct prompt path.
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

**Capture & manually review for this package — agent behavior / app plugin:**
- A **live-LLM** scenario trajectory showing the behavior end to end and asserting the **outcome**, not just that routing/an action was selected (see #9970).
- The artifacts the behavior creates — memories, knowledge, scheduled-task rows, relationships, documents, outputs — inspected after the run.
- Backend `[ClassName]` logs of the action/service/runner firing, plus error/edge/permission paths.
- The empty-state and adversarial-input behavior, not just one happy scenario.
<!-- END: evidence-and-e2e-mandate -->
