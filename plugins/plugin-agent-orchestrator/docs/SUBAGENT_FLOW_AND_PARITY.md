# Sub-agent flow & Codex / Claude-Code parity review

A thorough walk of how the main agent creates a task, spawns sub-agents,
provisions them, and communicates — across the elizaOS, Codex, and Claude
frameworks — plus an honest parity assessment against standalone Codex CLI and
Claude Code, and the concrete open items.

## 1. End-to-end flow

```
user msg → planner → TASKS_CREATE ─────────────► durable task (status: open)
                         │                         roomId, taskRoomId, ownerUserId,
                         │                         originalRequest, acceptanceCriteria
                         ▼
                   TASKS_SPAWN_AGENT ────────────► AcpService.spawnSession(SpawnOptions)
                         │   goal-prompt.ts wraps   agentType, workdir, goalPrompt,
                         │   the goal + rooms +      approvalPreset, metadata{roomId,
                         │   acceptance criteria     source, label, worldId, userId}
                         ▼
                   ACP subprocess (native JSON-RPC over stdio)
                   elizaos | codex | claude | opencode | pi-agent
                         │   session/new → session/prompt(goal)
                         ▼
                   events: ready · tool_running · message · reasoning · plan ·
                           blocked · task_complete · error · usage_update
                         │
        ┌────────────────┴───────────────────────────────┐
        ▼                                                  ▼
  OrchestratorTaskService.onSessionEvent          SubAgentRouter.handleEvent
  (durable: addEvent / updateSession /            (synthetic Memory → planner;
   recordMessage; task_complete → "validating")    round-trip cap = 32)
                                                          │
                                                          ▼
                                          planner ↔ subAgentCompletionResponseEvaluator
                                          → reply to user OR TASKS_SEND_TO_AGENT
```

**Key files:** task create `actions/tasks.ts:685` → `services/orchestrator-task-service.ts:746`;
spawn `actions/tasks.ts:743` → `services/acp-service.ts:511`; goal wrap
`services/goal-prompt.ts:129`; event bridge `orchestrator-task-service.ts:519`;
routing `services/sub-agent-router.ts`; completion gate
`orchestrator-task-service.ts:608` (`task_complete` → `validating`, never straight
to `done`); evaluator `evaluators/sub-agent-completion.ts`.

**Provisioning** happens at spawn: `acp-service.ts` resolves the workdir, captures
a git baseline SHA + dirty set (for the completion changeset), and writes a
sub-agent `AGENTS.md`/`CLAUDE.md` identity manifest on bare workdirs
(`sub-agent-identity.ts`). Explicit repo clone / worktree / branch / commit / push
/ PR is `CodingWorkspaceService` (`workspace-*.ts`), driven by
`TASKS_PROVISION_WORKSPACE` / `TASKS_SUBMIT_WORKSPACE`.

## 2. Sub-agent rooms per task

- `roomId` = the originating user channel (where the final reply goes).
  `taskRoomId` = a dedicated task-scoped room; all sessions' messages
  (`senderKind: user|orchestrator|sub_agent|system`) append there. Exposed via
  `GET /api/orchestrator/tasks/:id/messages`, `/timeline`, and `/stream` (SSE).
- The in-app **task view** (`plugin-task-coordinator/src/OrchestratorWorkbench.tsx`)
  renders this as a per-task message room: the merged timeline + per-sub-agent
  sessions list + plan + diff + usage + recovery, with near-live polling.
- On chat connectors, the **progress thread** (`index.ts emitProgress`) routes all
  sub-agent narration into a per-task Discord thread / Telegram forum topic
  (capability-gated on `create_thread` + `post_to_thread` + threaded progress
  mode), keeping the main channel clean. This is the "task info as threads in TG
  and Discord" surface.

## 3. Inter-agent communication

**Topology: hub-and-spoke.** Sub-agents do not address each other directly. Each
talks only to the parent:
- parent → sub: initial goal prompt; mid-flight `TASKS_SEND_TO_AGENT`; live user
  messages in the task room are auto-forwarded to the active session
  (`index.ts` MESSAGE_RECEIVED listener).
- sub → parent: terminal ACP events → synthetic memories; plus a sub-agent can
  emit `USE_SKILL parent-agent {…}` which the router dispatches to the
  parent-agent broker (`parent-agent-dispatch.ts` / `parent-agent-broker.ts`) and
  replies back over the session.
- sub → parent context: loopback-only bridge `GET /api/coding-agents/:id/context/*`
  (parent character, current room, memory search, active workspaces).

Multiple sub-agents per task are supported (`sessions[]`), unsynchronized; the
router de-dupes concurrent `task_complete` so only the first posts to the user.

## 4. Framework matrix (elizaOS / Codex / Claude)

All run as ACP subprocesses over the native JSON-RPC transport
(`acp-native-transport.ts`); spawn command per framework is env-overridable
(`ELIZA_{ELIZAOS,CODEX,CLAUDE,OPENCODE,PI_AGENT}_ACP_COMMAND`; Codex/Claude default
to pinned `npx` ACP shims). The orchestrator implements the ACP client side of:
`session/new`, `session/prompt`, `session/cancel`, `session/update` (streaming
`agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `plan`),
`session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, and the
`terminal/*` family. Approval presets (`readonly|standard|permissive|autonomous`)
gate file/terminal ops. Credentials reach sub-agents via the loopback credential
tunnel (`bridge-routes.ts`); host connector tokens are denylisted from the child
env, and Claude OAuth-subscription tokens are stripped so the child uses its own
subscription.

## 5. Parity vs standalone Codex CLI / Claude Code

**At parity:** multi-framework spawn + routing; file read/write; terminal exec;
plan/reasoning/tool streaming; approval gates; real git-diff capture & surfacing
(`coding-session-changes.ts`); token usage; orphaned-session recovery on restart;
durable task store + task view; per-task threads on connectors.

**Partial:** plan/todo events are emitted by OpenCode but not uniformly by
Codex/Claude; diff surfacing truncates (20 files / 50 lines) with no inline
per-line review UI; sub-agents run `--no-terminal` (event-driven, no interactive
TUI — correct for orchestration, but differs from a human at the CLI).

**Gaps:**
1. **MCP forwarding** — ✅ implemented (opt-in). `acp-native-transport.ts`
   forwards `ELIZA_ACP_MCP_SERVERS` (a JSON array of stdio/http MCP server
   configs) into `session/new.mcpServers` via `parseAcpMcpServersEnv`, so
   sub-agents get the parent's MCP tools (Codex / Claude-Code parity). Defaults
   to `[]` (prior behavior) so spawning never regresses. Remaining: auto-inherit
   the parent runtime's MCP set without explicit env config (needs a runtime
   MCP-config surface, which doesn't exist yet).
2. **Sub-agent nesting** (open) — no spawn-child API; a sub-agent cannot delegate
   to its own sub-agents (single level of orchestration). Feature-level work.
3. **Inline code-review surface** — diffs are captured but there's no structured
   per-file/line review/approve UI in the task view.

## 6. Open items checklist

- [x] Interaction protocol (forms / choice + custom / secret / task) across app + TG + Discord
- [x] Pick-an-option round-trip on both connectors; secret/OAuth DM link-out on both
- [x] Per-task threads on TG + Discord (orchestrator-driven; both connectors now capable)
- [x] Task view with sub-agent message room (OrchestratorWorkbench)
- [x] Real interaction-widget + connector round-trip tests
- [x] MCP server forwarding to sub-agents (opt-in via `ELIZA_ACP_MCP_SERVERS`)
- [ ] Sub-agent nesting / delegation (gap #2 — feature-level)
- [ ] Inline diff review UI in the task view (gap #3)
- [ ] Live connector E2E (needs TG/Discord credentials) + orchestrator HTTP task-flow E2E
- [ ] Optional: `outgoing_before_deliver` central interaction normalization hook

See `@elizaos/core` `src/messaging/interactions/README.md` for the interaction
protocol; this doc covers the orchestration + sub-agent layer.
