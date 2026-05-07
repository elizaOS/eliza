# PARITY_SPEC.md
Canonical parity specification for making `@elizaos/plugin-acpx` third-party compatible with the action surface of `@elizaos/plugin-agent-orchestrator`.
Source baseline:
- `.research/plugin-agent-orchestrator-README.md`
- `.research/plugin-agent-orchestrator-package.json`
- `.research/plugin-agent-orchestrator-src/index.ts`
- `.research/plugin-agent-orchestrator-src/actions/*.ts`
- `.research/plugin-agent-orchestrator-src/providers/*.ts`
- `.research/plugin-agent-orchestrator-src/services/pty-types.ts`
- `.research/plugin-agent-orchestrator-src/types/*.ts`
- `.research/nyx-spawn-codex/spawn_codex.js`
Audience:
- W4 implements `AcpxSubprocessService`.
- W5 implements durable `SessionStore`.
- W6 implements the action wrappers.
- Nyx swaps `plugin-agent-orchestrator` for `plugin-acp` by changing imports only.
Line references cite the research mirror under `.research/plugin-agent-orchestrator-src/` unless explicitly called out as README, package, or Nyx consumer.
---
## 1. Compatibility goal statement
### 1.1 Goal
`@elizaos/plugin-acpx` must expose a task-agent action surface that is drop-in compatible with the parts of `@elizaos/plugin-agent-orchestrator` used by third-party callers.
Drop-in compatible means:
1. A runtime action lookup by canonical name finds the expected action.
2. Legacy aliases in `similes` continue to route to the same behavior.
3. `Action.validate()` returns true or false under comparable conditions.
4. `Action.handler()` accepts the same Eliza handler signature:
   ```ts
   (
     runtime: IAgentRuntime,
     message: Memory,
     state?: State,
     options?: HandlerOptions,
     callback?: HandlerCallback,
   ) => Promise<ActionResult | undefined>
   ```
5. Input values are read from `options.parameters` first and `message.content` second, matching orchestrator extraction patterns.
6. Success and failure `ActionResult` shapes are compatible, especially `ActionResult.data.agents` for `CREATE_TASK`.
7. `HandlerCallback` usage is compatible enough that chat users and in-process consumers receive equivalent status and error text.
8. `runtime.getService("PTY_SERVICE")` can be replaced by the `AcpxSubprocessService` compatibility facade where callers expect orchestrator's PTY service.
9. Session events delivered through `onSessionEvent` match orchestrator event names and payload fields that consumers depend on.
Source references:
- The README defines the task-agent purpose and action list in README lines 3 to 14 and 64 to 76.
- `index.ts` registers services and actions in lines 36 to 77.
- `index.ts` exports compatibility aliases in lines 79 to 82 and action re-exports in lines 97 to 117.
- Nyx's real consumer looks up `CREATE_TASK`, `PTY_SERVICE`, and `onSessionEvent` in `.research/nyx-spawn-codex/spawn_codex.js` lines 83 to 90 and 117 to 150.
### 1.2 Side-by-side loading
`@elizaos/plugin-acpx` may be loaded side-by-side with `@elizaos/plugin-agent-orchestrator` during migration.
Side-by-side requirement:
1. Plugin name must be distinct, for example `@elizaos/plugin-acpx`.
2. Canonical action names overlap by design. Eliza runtimes that allow duplicate action names may use load order to choose. Tests must cover runtime lookup by name.
3. Services should avoid clobbering orchestrator internals unless compatibility mode is explicitly enabled.
4. To satisfy third-party consumers, @elizaos/plugin-acpx must provide at least one service discoverable as `PTY_SERVICE` or a documented alias/facade that W6 uses to wire action handlers.
5. @elizaos/plugin-acpx may additionally provide `ACP_SUBPROCESS_SERVICE`, but external compatibility requires the `PTY_SERVICE`-compatible method surface.
Recommendation:
- Register `AcpxSubprocessService` under `ACP_SUBPROCESS_SERVICE` as the primary service.
- Register or expose a thin `PTY_SERVICE` facade that delegates to it when no existing `PTY_SERVICE` is present.
- If another plugin already registered `PTY_SERVICE`, do not replace it by default. Log a warning and keep @elizaos/plugin-acpx action handlers using `ACP_SUBPROCESS_SERVICE` directly. For Nyx compatibility, deployments that swap imports must not load orchestrator simultaneously.
### 1.3 Deliberate non-goals
@elizaos/plugin-acpx is not required to replicate the full Milady orchestrator product.
Do not match:
1. Git workspace provisioning actions, except for minimal workdir/scratch behavior required by `CREATE_TASK`.
2. `PROVISION_WORKSPACE` and `FINALIZE_WORKSPACE` action behavior.
3. `CodingWorkspaceService` full git worktree, commit, push, PR, and GitHub behavior.
4. SwarmCoordinator's durable decision loop and front-end xterm streaming.
5. Milady subscription-aware provider selection.
6. Account-pool failover for Claude subscriptions.
7. Skill callback bridge and virtual skill routing.
8. Structured proof bridge for app/plugin sentinels.
9. Task history, task share, issue management, and frontend API routes.
### 1.4 Compatible but cleaner alternatives
Some orchestrator behavior is intentionally ugly or product-specific. @elizaos/plugin-acpx should mirror third-party contracts, not every implementation wart.
Keep these contracts:
- `CREATE_TASK` returns `{ data: { agents: [...] } }` with `sessionId`, `agentType`, `workdir`, `label`, and `status`.
- `onSessionEvent` emits `task_complete` with `{ response }`, `stopped`, and `error` with `{ message }`.
- `ActionResult.text` on successful async task creation is `""` to avoid duplicate chat messages.
Clean alternatives:
- Replace the heavy SwarmCoordinator with a compact session store plus event emitter.
- Replace subscription-aware auto-picking with deterministic env defaults.
- Replace workspace service dependencies with @elizaos/plugin-acpx-managed scratch directories.
- Implement `CANCEL_TASK` as a clean canonical action instead of relying on `TASK_CONTROL` or `STOP_AGENT` naming ambiguity.
### 1.5 TODO verification markers
This spec uses `**TODO verify**` only where source behavior was not fully explicit or where @elizaos/plugin-acpx must make a choice because orchestrator has no exact action.
---
## 2. Action specs
All six actions must be registered on the plugin:
1. `SPAWN_AGENT`
2. `SEND_TO_AGENT`
3. `LIST_AGENTS`
4. `STOP_AGENT`
5. `CREATE_TASK`
6. `CANCEL_TASK`
Action order should match orchestrator's user-facing priority where possible:
1. `CREATE_TASK`
2. `SPAWN_AGENT`
3. `SEND_TO_AGENT`
4. `STOP_AGENT`
5. `LIST_AGENTS`
6. `CANCEL_TASK`
Orchestrator registers `CREATE_TASK` via `startCodingTaskAction` before direct PTY actions in `index.ts` lines 51 to 59.
---
### 2.1 Common action handler signature
Every action handler must have this signature:
```ts
handler: async (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  options?: HandlerOptions,
  callback?: HandlerCallback,
): Promise<ActionResult | undefined> => { ... }
```
Source references:
- `SPAWN_AGENT`: `spawn-agent.ts` lines 198 to 204.
- `SEND_TO_AGENT`: `send-to-agent.ts` lines 96 to 102.
- `LIST_AGENTS`: `list-agents.ts` lines 99 to 105.
- `STOP_AGENT`: `stop-agent.ts` lines 92 to 98.
- `CREATE_TASK`: `start-coding-task.ts` lines 410 to 416.
Common extraction pattern:
```ts
const params = options?.parameters as Record<string, unknown> | undefined;
const content = message.content as Record<string, unknown>;
const value = (params?.field as T) ?? (content.field as T);
```
Source references:
- `SPAWN_AGENT` extracts params and content in `spawn-agent.ts` lines 227 to 232.
- `SEND_TO_AGENT` extracts params and content in `send-to-agent.ts` lines 125 to 132.
- `STOP_AGENT` extracts params and content in `stop-agent.ts` lines 121 to 125.
- `CREATE_TASK` extracts params and content in `start-coding-task.ts` lines 443 to 445.
Common service requirement:
- Orchestrator validates by checking `runtime.getService("PTY_SERVICE")` for most actions.
- `@elizaos/plugin-acpx` must either provide that service name or make action handlers resolve `AcpxSubprocessService` first and expose a compatibility facade for external callers.
Common access policy:
- Orchestrator calls `requireTaskAgentAccess(runtime, message, "create")` for create/spawn and `"interact"` for list/send/stop/control.
- @elizaos/plugin-acpx can omit Milady-specific access policy unless its runtime has equivalent controls, but it must preserve the error shape `{ success: false, error: "FORBIDDEN", text: reason }` if access is denied.
---
### 2.2 `SPAWN_AGENT`
#### 2.2.1 Name
```ts
name: "SPAWN_AGENT"
```
Source: `spawn-agent.ts` line 112.
#### 2.2.2 Aliases
Mirror orchestrator `similes` exactly:
```ts
[
  "SPAWN_CODING_AGENT",
  "START_CODING_AGENT",
  "LAUNCH_CODING_AGENT",
  "CREATE_CODING_AGENT",
  "SPAWN_CODER",
  "RUN_CODING_AGENT",
  "SPAWN_SUB_AGENT",
  "START_TASK_AGENT",
  "CREATE_AGENT",
]
```
Source: `spawn-agent.ts` lines 114 to 124.
#### 2.2.3 Description
Mirror intent:
- Spawn a specific task agent inside an existing workspace when direct control is needed.
- Agents are open-ended and can investigate, write, plan, test, synthesize, do repo work, and execute general async tasks.
- Returns a session ID for follow-up actions.
Source: `spawn-agent.ts` lines 126 to 129.
#### 2.2.4 Suppress continuation
Set:
```ts
suppressPostActionContinuation: true
```
Rationale:
- The action starts asynchronous work.
- A non-empty continuation can trigger duplicate spawns.
Source: `spawn-agent.ts` lines 131 to 139.
#### 2.2.5 Input schema
Parameters @elizaos/plugin-acpx must accept:
```ts
parameters: [
  { name: "agentType", required: false, schema: { type: "string" } },
  { name: "task", required: false, schema: { type: "string" } },
  { name: "workdir", required: false, schema: { type: "string" } },
  { name: "memoryContent", required: false, schema: { type: "string" } },
  { name: "approvalPreset", required: false, schema: { type: "string", enum: ["readonly", "standard", "permissive", "autonomous"] } },
  { name: "keepAliveAfterComplete", required: false, schema: { type: "boolean" } },
]
```
Orchestrator reads these dynamically:
- `task`: `spawn-agent.ts` line 231.
- `agentType`: `spawn-agent.ts` lines 266 to 280.
- `workdir`: `spawn-agent.ts` lines 276 to 286.
- `memoryContent`: `spawn-agent.ts` lines 381 to 382.
- `approvalPreset`: `spawn-agent.ts` lines 383 to 384 and 531 to 533.
- `keepAliveAfterComplete`: `spawn-agent.ts` lines 385 to 387 and 520.
@elizaos/plugin-acpx addition:
- Declare the parameter metadata explicitly so action documentation is complete.
#### 2.2.6 Validation rules
Return `false` if service is unavailable.
Return `true` if message has explicit spawn payload:
- `content.task` is string
- `content.workdir` is string
- `content.agentType` is string
Return `true` for empty text.
Otherwise return whether text looks like a task-agent request.
Source:
- Service check: `spawn-agent.ts` lines 174 to 183.
- Explicit payload check: `spawn-agent.ts` lines 87 to 100 and 186 to 188.
- Empty text behavior: `spawn-agent.ts` lines 190 to 193.
- Task-agent text heuristic: `spawn-agent.ts` line 195.
@elizaos/plugin-acpx implementation guidance:
- If @elizaos/plugin-acpx does not implement `looksLikeTaskAgentRequest`, use a simple complexity regex covering code, debug, fix, implement, investigate, research, summarize, write, plan, delegate, subagent, repo, test.
- This regex mirrors `task-agent-frameworks.ts` lines 234 to 235.
#### 2.2.7 Handler behavior
Ordered behavior:
1. Enforce create access if an access policy exists. On deny, callback with reason and return `{ success: false, error: "FORBIDDEN", text: reason }`. Source: `spawn-agent.ts` lines 205 to 213.
2. Resolve service. If absent, callback `"PTY Service is not available. Cannot spawn a task agent."` and return `{ success: false, error: "SERVICE_UNAVAILABLE" }`. Source: `spawn-agent.ts` lines 215 to 225.
3. Extract `task` from params or content. Source: `spawn-agent.ts` lines 227 to 232.
4. Preserve full user text if planner extracted a shorter task. Source helper: `start-coding-task.ts` lines 206 to 216, used by `spawn-agent.ts` line 282.
5. If user text contains multiple distinct asks, redirect to `CREATE_TASK`. Source: `spawn-agent.ts` lines 234 to 260.
6. Resolve agent type from explicit hint or `service.resolveAgentType({ task, workdir })`. Normalize aliases from `pty-types.ts` lines 42 to 71.
7. Resolve workdir from explicit field, `state.codingWorkspace.path`, latest workspace, or scratch fallback. Source: `spawn-agent.ts` lines 285 to 309.
8. Enforce sandbox if implemented. Source: `spawn-agent.ts` lines 311 to 379.
9. Build credentials or acpx env. Orchestrator returns `INVALID_CREDENTIALS` on credential errors. Source: `spawn-agent.ts` lines 409 to 424.
10. Preflight non-shell agents. If CLI absent, callback install text and return `{ success: false, error: "AGENT_NOT_INSTALLED" }`. Source: `spawn-agent.ts` lines 426 to 442.
11. Create a task thread if a store/coordinator exists. Source: `spawn-agent.ts` lines 445 to 467.
12. Spawn session through service. Source: `spawn-agent.ts` lines 523 to 543.
13. Subscribe to session events for blocked, completion, and errors when no coordinator owns chat. Source: `spawn-agent.ts` lines 578 to 610.
14. Register task in store/coordinator if available. Source: `spawn-agent.ts` lines 611 to 619.
15. Set `state.codingSession = session` if state exists. **TODO verify** exact source line after 620 was not re-read, but stop/send actions rely on `state.codingSession` in `send-to-agent.ts` lines 134 to 138 and `stop-agent.ts` lines 164 to 168.
16. Return success with empty text if possible to avoid duplicate chat.
#### 2.2.8 Output shape
@elizaos/plugin-acpx must return this shape on success:
```ts
{
  success: true,
  text: "",
  data: {
    sessionId: string,
    agentType: string,
    workdir: string,
    status: string,
    label?: string,
    suppressActionResultClipboard?: true,
  },
}
```
Compatibility note:
- `SPAWN_AGENT` is direct-session oriented. Nyx does not consume it.
- To make W6 simpler, @elizaos/plugin-acpx may also include `data.agents: [agentRecord]`, but this is required only for `CREATE_TASK`.
#### 2.2.9 HandlerCallback usage
Use callback for:
- Access denial reason.
- Service unavailable.
- Workdir outside sandbox.
- Invalid credentials.
- CLI not installed.
- Non-coordinator blocked prompt: `Task agent is waiting for input: ...`.
- Non-coordinator error: `Task agent encountered an error: ...`.
Source:
- Access denial: `spawn-agent.ts` lines 205 to 213.
- Service unavailable: `spawn-agent.ts` lines 215 to 225.
- Sandbox denial: `spawn-agent.ts` lines 367 to 377.
- Invalid credentials: `spawn-agent.ts` lines 416 to 424.
- CLI missing: `spawn-agent.ts` lines 432 to 441.
- Event callbacks: `spawn-agent.ts` lines 587 to 608.
Do not emit routine success callback if async final synthesis will follow.
#### 2.2.10 Error modes
Return these exact `error` codes where applicable:
- `FORBIDDEN`
- `SERVICE_UNAVAILABLE`
- `WORKDIR_OUTSIDE_ALLOWED`
- `INVALID_CREDENTIALS`
- `AGENT_NOT_INSTALLED`
- raw error message string on unexpected spawn failure
#### 2.2.11 Notes for W4
`AcpxSubprocessService.spawnSession` must accept `SpawnSessionOptions` and return `SessionInfo`.
It must:
- Generate stable `session.id` strings.
- Persist `metadata` with at least `requestedType`, `messageId`, optional `threadId`, optional `label`, optional `userId`.
- Emit `ready`, `task_complete`, `stopped`, and `error` events through `onSessionEvent`.
- Support `resolveAgentType`, `checkAvailableAgents`, `defaultApprovalPreset`, and `agentSelectionStrategy` or W6 must shim them.
---
### 2.3 `SEND_TO_AGENT`
#### 2.3.1 Name
```ts
name: "SEND_TO_AGENT"
```
Source: `send-to-agent.ts` line 25.
#### 2.3.2 Aliases
Mirror orchestrator:
```ts
[
  "SEND_TO_CODING_AGENT",
  "MESSAGE_CODING_AGENT",
  "INPUT_TO_AGENT",
  "RESPOND_TO_AGENT",
  "TELL_CODING_AGENT",
  "MESSAGE_AGENT",
  "TELL_TASK_AGENT",
]
```
Source: `send-to-agent.ts` lines 27 to 35.
#### 2.3.3 Description
Send text input or key presses to a running task-agent session. Use it to respond to prompts, provide feedback, continue a task, or assign a fresh tracked task to an existing agent.
Source: `send-to-agent.ts` lines 37 to 39.
#### 2.3.4 Input schema
Mirror parameter metadata:
```ts
parameters: [
  { name: "sessionId", required: false, schema: { type: "string" } },
  { name: "input", required: false, schema: { type: "string" } },
  { name: "task", required: false, schema: { type: "string" } },
  { name: "label", required: false, schema: { type: "string" } },
  { name: "keys", required: false, schema: { type: "string" } },
]
```
Source: `send-to-agent.ts` lines 275 to 311.
#### 2.3.5 Validation rules
Return false if service unavailable.
Return true only if `listSessions()` completes within 2 seconds and has at least one session.
Source: `send-to-agent.ts` lines 70 to 94.
@elizaos/plugin-acpx implementation guidance:
- Preserve the 2 second validation timeout so action selection does not hang.
- W4 `listSessions()` must be fast and safe.
#### 2.3.6 Handler behavior
1. Enforce interact access. On deny, callback reason and return `{ success: false, error: "FORBIDDEN", text: reason }`. Source: `send-to-agent.ts` lines 103 to 111.
2. Resolve service. If absent, callback `"PTY Service is not available."` and return `{ success: false, error: "SERVICE_UNAVAILABLE" }`. Source: `send-to-agent.ts` lines 113 to 123.
3. Read `sessionId`, `input`, `keys`, `task`, `label` from params then content. Source: `send-to-agent.ts` lines 125 to 132 and 164 to 168.
4. Resolve target session from explicit `sessionId`, `state.codingSession.id`, or newest session. Source: `send-to-agent.ts` lines 134 to 152.
5. If no sessions exist, callback `"No active task-agent sessions. Spawn an agent first."` and return `{ success: false, error: "NO_SESSION" }`. Source: `send-to-agent.ts` lines 140 to 150.
6. If session not found, callback `Session ${sessionId} not found.` and return `{ success: false, error: "SESSION_NOT_FOUND" }`. Source: `send-to-agent.ts` lines 154 to 162.
7. If `keys` provided, call `sendKeysToSession`, callback success, and return `{ success: true, text: "Sent key sequence", data: { sessionId, keys } }`. Source: `send-to-agent.ts` lines 170 to 182.
8. Else if `input` or `task` provided, send text, optionally register a tracked task, callback, and return data with `sessionId`, `input`, and optional `task`. Source: `send-to-agent.ts` lines 183 to 254.
9. Else callback `"No input provided. Specify 'input', 'task', or 'keys' parameter."` and return `{ success: false, error: "NO_INPUT" }`. Source: `send-to-agent.ts` lines 255 to 261.
10. Catch unexpected errors, callback `Failed to send to agent: ...`, return `{ success: false, error: errorMessage }`. Source: `send-to-agent.ts` lines 263 to 272.
#### 2.3.7 Output shape
Keys case:
```ts
{ success: true, text: "Sent key sequence", data: { sessionId: string, keys: string } }
```
Input case:
```ts
{
  success: true,
  text: "Assigned new task to agent" | "Sent input to agent",
  data: { sessionId: string, input: string, task?: string },
}
```
Source: `send-to-agent.ts` lines 178 to 182 and 244 to 254.
#### 2.3.8 Error modes
- `FORBIDDEN`
- `SERVICE_UNAVAILABLE`
- `NO_SESSION`
- `SESSION_NOT_FOUND`
- `NO_INPUT`
- raw error message string
#### 2.3.9 Notes for W4
W4 must implement:
- `sendToSession(sessionId, input)`
- `sendKeysToSession(sessionId, keys)`
- `getSession(sessionId)`
- `listSessions()`
`sendToSession` should cancel pending auto-stop timers or equivalent so follow-up input is not lost. Orchestrator does this in `pty-service.ts` lines 1122 to 1130.
---
### 2.4 `LIST_AGENTS`
#### 2.4.1 Name
```ts
name: "LIST_AGENTS"
```
Source: `list-agents.ts` line 53.
#### 2.4.2 Aliases
Mirror orchestrator:
```ts
[
  "LIST_CODING_AGENTS",
  "SHOW_CODING_AGENTS",
  "GET_ACTIVE_AGENTS",
  "LIST_SESSIONS",
  "SHOW_CODING_SESSIONS",
  "SHOW_TASK_AGENTS",
  "LIST_SUB_AGENTS",
  "SHOW_TASK_STATUS",
]
```
Source: `list-agents.ts` lines 55 to 64.
#### 2.4.3 Description
List active task agents together with current task progress so the main agent can keep the user updated while work continues asynchronously.
Source: `list-agents.ts` lines 66 to 69.
#### 2.4.4 Input schema
No parameters:
```ts
parameters: []
```
Source: `list-agents.ts` line 249.
#### 2.4.5 Validation rules
Return true when service is present.
Source: `list-agents.ts` lines 89 to 97.
#### 2.4.6 Handler behavior
1. Enforce interact access. Source: `list-agents.ts` lines 106 to 114.
2. Resolve service. If absent, callback `"PTY Service is not available."` and return `{ success: false, error: "SERVICE_UNAVAILABLE" }`. Source: `list-agents.ts` lines 116 to 126.
3. Load sessions with `listSessions()`. Source: `list-agents.ts` line 128.
4. Load current tasks from store/coordinator if available. Source: `list-agents.ts` lines 129 to 132.
5. Load framework state if available. Source: `list-agents.ts` lines 133 to 136.
6. If no sessions and no tasks, callback a text beginning `No active task agents.` and return success data with empty sessions/tasks and `preferredTaskAgent`. Source: `list-agents.ts` lines 138 to 153.
7. Else build text sections for active agents, current status, reusable task agents, and pending confirmations. Source: `list-agents.ts` lines 156 to 214.
8. Callback with text and return success with structured data. Source: `list-agents.ts` lines 215 to 246.
#### 2.4.7 Output shape
```ts
{
  success: true,
  text: string,
  data: {
    sessions: Array<{
      id: string,
      agentType: string,
      status: string,
      workdir: string,
      createdAt: string,
      lastActivity: string,
      label: string,
    }>,
    tasks: Array<{
      sessionId: string,
      agentType: string,
      label: string,
      status: string,
      originalTask: string,
      completionSummary?: string,
    }>,
    pendingConfirmations: number,
    preferredTaskAgent: { id: string, reason: string },
  },
}
```
Source: `list-agents.ts` lines 219 to 245.
Empty case returns:
```ts
{ sessions: [], tasks: [], preferredTaskAgent }
```
Source: `list-agents.ts` lines 145 to 153.
#### 2.4.8 HandlerCallback usage
Always callback with the same `text` returned in `ActionResult.text`, except access/service failures.
Source: `list-agents.ts` lines 142 to 143 and 215 to 216.
#### 2.4.9 Error modes
- `FORBIDDEN`
- `SERVICE_UNAVAILABLE`
#### 2.4.10 Notes for W4 and W5
W4 provides live sessions.
W5 provides durable tasks. If W5 is not yet implemented, return `tasks: []` and `pendingConfirmations: 0` but keep the fields.
---
### 2.5 `STOP_AGENT`
#### 2.5.1 Name
```ts
name: "STOP_AGENT"
```
Source: `stop-agent.ts` line 24.
#### 2.5.2 Aliases
Mirror orchestrator:
```ts
[
  "STOP_CODING_AGENT",
  "KILL_CODING_AGENT",
  "TERMINATE_AGENT",
  "END_CODING_SESSION",
  "CANCEL_AGENT",
  "CANCEL_TASK_AGENT",
  "STOP_SUB_AGENT",
]
```
Source: `stop-agent.ts` lines 26 to 34.
@elizaos/plugin-acpx addition:
- `CANCEL_TASK` should be a separate canonical action, but `STOP_AGENT.similes` must still include `CANCEL_TASK_AGENT`.
#### 2.5.3 Description
Stop a running task-agent session, terminating the PTY session and cleaning up resources.
Source: `stop-agent.ts` lines 36 to 38.
#### 2.5.4 Input schema
```ts
parameters: [
  { name: "sessionId", required: false, schema: { type: "string" } },
  { name: "all", required: false, schema: { type: "boolean" } },
]
```
Source: `stop-agent.ts` lines 226 to 241.
#### 2.5.5 Validation rules
Return false if service unavailable.
Return true only if `listSessions()` completes within 2 seconds and has at least one session.
Source: `stop-agent.ts` lines 69 to 90.
#### 2.5.6 Handler behavior
1. Enforce interact access. Source: `stop-agent.ts` lines 99 to 107.
2. Resolve service. If absent, callback `"PTY Service is not available."` and return `{ success: false, error: "SERVICE_UNAVAILABLE" }`. Source: `stop-agent.ts` lines 109 to 119.
3. If `all` is true, stop all sessions, clear state, callback count, and return `{ success: true, text: "Stopped N sessions", data: { stoppedCount: N } }`. Source: `stop-agent.ts` lines 127 to 162.
4. Else resolve specific session from explicit `sessionId`, `state.codingSession.id`, or newest session. Source: `stop-agent.ts` lines 164 to 181.
5. If no sessions, callback and return success no-op. Source: `stop-agent.ts` lines 170 to 179.
6. If target not found, callback `Session ${sessionId} not found.`, return `{ success: false, error: "SESSION_NOT_FOUND" }`. Source: `stop-agent.ts` lines 183 to 191.
7. Stop session. Clear state if it was current. Source: `stop-agent.ts` lines 193 to 202.
8. Callback `Stopped task-agent session ${sessionId}.` Source: `stop-agent.ts` lines 204 to 208.
9. Return `{ success: true, text: `Stopped session ${sessionId}`, data: { sessionId, agentType } }`. Source: `stop-agent.ts` lines 209 to 213.
10. Catch failure, callback `Failed to stop agent: ...`, return `{ success: false, error: errorMessage }`. Source: `stop-agent.ts` lines 214 to 223.
#### 2.5.7 Output shape
All case:
```ts
{ success: true, text: `Stopped ${count} sessions`, data: { stoppedCount: count } }
```
Specific case:
```ts
{ success: true, text: `Stopped session ${sessionId}`, data: { sessionId: string, agentType: string } }
```
No-op case:
```ts
{ success: true, text: "No sessions to stop" }
```
#### 2.5.8 Error modes
- `FORBIDDEN`
- `SERVICE_UNAVAILABLE`
- `SESSION_NOT_FOUND`
- raw error message string
#### 2.5.9 Notes for W4
`stopSession(sessionId, force?)` must emit a `stopped` event after termination.
Orchestrator records terminal state on `stopped` and `error` in `pty-service.ts` lines 2134 to 2162 and then calls event callbacks in lines 2165 to 2171.
---
### 2.6 `CREATE_TASK`
#### 2.6.1 Name
```ts
name: "CREATE_TASK"
```
Source: `start-coding-task.ts` line 287.
#### 2.6.2 Aliases
Mirror orchestrator:
```ts
[
  "START_CODING_TASK",
  "LAUNCH_CODING_TASK",
  "RUN_CODING_TASK",
  "START_AGENT_TASK",
  "SPAWN_AND_PROVISION",
  "CODE_THIS",
  "LAUNCH_TASK",
  "CREATE_SUBTASK",
]
```
Source: `start-coding-task.ts` lines 289 to 298.
#### 2.6.3 Description
Create one or more asynchronous task agents for any open-ended multi-step job. Agents can code, debug, research, write, analyze, plan, document, and automate while the main agent remains available. If a repo is provided, provision workspace automatically. If no repo, use a safe scratch directory. Use whenever work is more involved than a simple direct reply.
Source: `start-coding-task.ts` lines 300 to 310.
#### 2.6.4 Suppress continuation
Set:
```ts
suppressPostActionContinuation: true
```
Source: `start-coding-task.ts` line 312.
#### 2.6.5 Input schema
Mirror orchestrator declared parameters:
```ts
parameters: [
  { name: "repo", required: false, schema: { type: "string" } },
  { name: "agentType", required: false, schema: { type: "string" } },
  { name: "task", required: false, schema: { type: "string" } },
  { name: "agents", required: false, schema: { type: "string" } },
  { name: "memoryContent", required: false, schema: { type: "string" } },
  { name: "label", required: false, schema: { type: "string" } },
  { name: "approvalPreset", required: false, schema: { type: "string", enum: ["readonly", "standard", "permissive", "autonomous"] } },
  { name: "validator", required: false, schema: { type: "object" } },
  { name: "maxRetries", required: false, schema: { type: "integer", minimum: 0 } },
  { name: "onVerificationFail", required: false, schema: { type: "string", enum: ["retry", "escalate"] } },
  { name: "metadata", required: false, schema: { type: "object" } },
]
```
Source: `start-coding-task.ts` lines 659 to 772.
@elizaos/plugin-acpx must additionally accept undeclared but consumed values:
```ts
{ workdir?: string, reuseRepo?: boolean, model?: string }
```
Rationale:
- `hasExplicitTaskPayload` treats `workdir` as explicit payload in `start-coding-task.ts` lines 95 to 110.
- Nyx synthetic message sets `workdir` and optional `model` in `.research/nyx-spawn-codex/spawn_codex.js` lines 106 to 123 and 216 to 227.
- `reuseRepo` is read in `start-coding-task.ts` lines 479 to 485.
#### 2.6.6 Validation rules
Return false if service unavailable.
Return true if message has explicit task payload:
- `content.task` string
- `content.repo` string
- `content.workdir` string
- `content.agents` string
- `content.agentType` string
Return true for empty text.
Decline LifeOps-like todo/reminder prompts so other actions can win.
Otherwise return task-agent request heuristic.
Source:
- Service check: `start-coding-task.ts` lines 381 to 390.
- Explicit payload: `start-coding-task.ts` lines 95 to 110 and 392 to 394.
- Empty text: `start-coding-task.ts` lines 396 to 399.
- LifeOps rejection: `start-coding-task.ts` lines 121 to 143 and 401 to 405.
- Task-agent heuristic: `start-coding-task.ts` line 407.
#### 2.6.7 Handler behavior
High-level behavior:
1. Enforce create access. On deny return `FORBIDDEN`. Source: `start-coding-task.ts` lines 417 to 425.
2. Resolve service. If absent, callback `"PTY Service is not available. Cannot create the task."` and return `SERVICE_UNAVAILABLE`. Source: `start-coding-task.ts` lines 427 to 437.
3. Resolve optional workspace service. Source: `start-coding-task.ts` lines 439 to 441.
4. Extract params and content. Source: `start-coding-task.ts` lines 443 to 445.
5. Reject shell/pi/bash agentType for prose and let resolver choose. Source: `start-coding-task.ts` lines 447 to 458 and helper lines 264 to 280.
6. Read `memoryContent` and `approvalPreset`. Source: `start-coding-task.ts` lines 459 to 462.
7. Resolve `repo` from params/content/text URL. Source: `start-coding-task.ts` lines 464 to 473.
8. If `reuseRepo`, try fallback repo from coordinator or workspace service. Source: `start-coding-task.ts` lines 475 to 504.
9. Normalize repo input if present. Source: `start-coding-task.ts` lines 506 to 508.
10. Resolve default agent type through `service.resolveAgentType({ task, repo, subtaskCount })`. Source: `start-coding-task.ts` lines 510 to 528.
11. Build credentials or acpx env. On failure return `INVALID_CREDENTIALS`. Source: `start-coding-task.ts` lines 530 to 560.
12. Validate optional validator spec, retry count, fail behavior, and origin room id. Source: `start-coding-task.ts` lines 52 to 93 and 566 to 599.
13. Build `CodingTaskContext`. Source: `start-coding-task.ts` lines 601 to 623.
14. Dispatch to multi-agent handler by split user text, `agents`, or single preserved task. Source: `start-coding-task.ts` lines 625 to 657.
#### 2.6.8 Multi-agent behavior
@elizaos/plugin-acpx must mimic `handleMultiAgent` public contract, not the entire implementation.
Required behavior:
1. Parse `agents` by `|`, trim, filter empty. Source: `coding-task-handlers.ts` lines 669 to 679.
2. Cap count to `MAX_CONCURRENT_AGENTS`. Source: `coding-task-handlers.ts` lines 681 to 689. **TODO verify** the actual constant value in source header if @elizaos/plugin-acpx wants exact cap. Recommended @elizaos/plugin-acpx cap: 8 to match PTY default concurrency in `pty-types.ts` lines 25 to 36.
3. If repo present and no workspace implementation, either return `{ success: false, error: "WORKSPACE_SERVICE_UNAVAILABLE" }` or support minimal clone/workdir behavior. Source: `coding-task-handlers.ts` lines 691 to 698.
4. Do not emit routine `Launching N agents...` callback. Source: `coding-task-handlers.ts` lines 700 to 703.
5. Create one task thread in W5 if store exists. Source: `coding-task-handlers.ts` lines 762 to 790.
6. For each agent, detect optional prefix, derive task/type/label, provision workdir, preflight, spawn, register in W5, and push result record. Source: `coding-task-handlers.ts` lines 791 to 1060.
7. On per-agent spawn failure, append a failed result with `sessionId: ""`, `status: "failed"`, and `error`. Source: `coding-task-handlers.ts` lines 1064 to 1085.
8. Store successful sessions in `state.codingSessions`. Source: `coding-task-handlers.ts` lines 1089 to 1092.
9. If any failed, callback failure text and return `success: false`, `text`, `data: { agents: results, suppressActionResultClipboard: true }`. Source: `coding-task-handlers.ts` lines 1094 to 1115.
10. If all succeeded, return `success: true`, `text: ""`, `data: { agents: results, suppressActionResultClipboard: true }`. Source: `coding-task-handlers.ts` lines 1118 to 1122.
#### 2.6.9 Required output shape
`CREATE_TASK` success must return exactly this compatible shape:
```ts
{
  success: true,
  text: "",
  data: {
    agents: Array<{
      sessionId: string,
      agentType: string,
      workdir: string,
      workspaceId?: string,
      branch?: string,
      label: string,
      status: string,
      error?: string,
    }>,
    suppressActionResultClipboard: true,
  },
}
```
Source: `coding-task-handlers.ts` lines 746 to 755, 1052 to 1060, and 1118 to 1122.
Failure with partial agent failures:
```ts
{
  success: false,
  text: string,
  data: { agents: Array<AgentLaunchRecord>, suppressActionResultClipboard: true },
}
```
Source: `coding-task-handlers.ts` lines 1102 to 1115.
Nyx critical requirement:
- `data.agents` must be an array.
- Every successful record must have non-empty string `sessionId`.
- Nyx extracts session ids with `.map(a => a.sessionId)` in `.research/nyx-spawn-codex/spawn_codex.js` lines 245 to 253.
#### 2.6.10 HandlerCallback usage
Do not callback on routine success.
Callback on:
- access denied
- service unavailable
- invalid credentials
- too many agents
- workspace service unavailable
- launch failure summary
- event error if direct callback path is active
Source:
- Access denied: `start-coding-task.ts` lines 417 to 425.
- Service unavailable: `start-coding-task.ts` lines 427 to 437.
- Invalid credentials: `start-coding-task.ts` lines 550 to 560.
- Too many agents: `coding-task-handlers.ts` lines 681 to 689.
- Workspace service unavailable: `coding-task-handlers.ts` lines 691 to 698.
- Launch failure: `coding-task-handlers.ts` lines 1102 to 1110.
Important:
- The success path intentionally uses empty `ActionResult.text` because the runtime may auto-forward non-empty text to chat. Source: `coding-task-handlers.ts` lines 1096 to 1101.
#### 2.6.11 Error modes
- `FORBIDDEN`
- `SERVICE_UNAVAILABLE`
- `INVALID_CREDENTIALS`
- `TOO_MANY_AGENTS`
- `WORKSPACE_SERVICE_UNAVAILABLE`
- launch failure through `success: false` with `data.agents` and no top-level `error`
#### 2.6.12 Notes for W4
W4 must expose `resolveAgentType(selection?)`.
Minimum @elizaos/plugin-acpx behavior:
- Explicit `agentType` wins.
- Else `ELIZA_ACP_DEFAULT_AGENT` wins.
- Else `PARALLAX_DEFAULT_AGENT_TYPE` compatibility value wins.
- Else default to `codex` if `ELIZA_ACP_CLI` contains codex or `codex` exists on PATH.
- Else first available acpx CLI.
W4 must support per-spawn metadata and env forwarding so `model` from Nyx can be translated to acpx CLI model configuration.
#### 2.6.13 Notes for W5
W5 must create one durable task thread per `CREATE_TASK` call, then one task session per spawned acpx process.
Minimum durable state:
- thread id
- title/label
- original request
- room id/world id/user id
- session id
- agent type
- workdir
- status
- completion summary
- timestamps
- metadata
---
### 2.7 `CANCEL_TASK`
#### 2.7.1 Name
```ts
name: "CANCEL_TASK"
```
#### 2.7.2 Source status
`plugin-agent-orchestrator` does not define a canonical `CANCEL_TASK` action in the researched action files.
Related source behavior:
- `STOP_AGENT` includes `CANCEL_AGENT` and `CANCEL_TASK_AGENT` aliases in `stop-agent.ts` lines 26 to 34.
- `TASK_CONTROL` includes `STOP_TASK` and infers `stop` from the word `cancel` in `task-control.ts` lines 14 to 20, 43 to 51, and 54 to 64.
- `TASK_CONTROL` handler stops durable task threads, not just PTY sessions, in `task-control.ts` lines 171 to 207.
Because the user explicitly requires `CANCEL_TASK`, @elizaos/plugin-acpx must add it as a clean canonical compatibility action.
#### 2.7.3 Aliases
Recommended:
```ts
[
  "STOP_TASK",
  "CANCEL_AGENT_TASK",
  "CANCEL_TASK_AGENT",
  "ABORT_TASK",
  "KILL_TASK",
  "STOP_SUBTASK",
]
```
Do not remove `CANCEL_TASK_AGENT` from `STOP_AGENT` aliases.
#### 2.7.4 Description
Cancel a durable task and stop any associated task-agent sessions, preserving history and marking sessions/threads as canceled or interrupted.
#### 2.7.5 Input schema
```ts
parameters: [
  { name: "threadId", required: false, schema: { type: "string" } },
  { name: "sessionId", required: false, schema: { type: "string" } },
  { name: "search", required: false, schema: { type: "string" } },
  { name: "all", required: false, schema: { type: "boolean" } },
  { name: "reason", required: false, schema: { type: "string" } },
]
```
This is a clean alternative to `TASK_CONTROL`'s broader schema, which includes `operation`, `threadId`, `sessionId`, `search`, `note`, `instruction`, and `agentType` in `task-control.ts` lines 218 to 263.
#### 2.7.6 Validation rules
Return true if either:
- W5 session store has any active task threads, or
- W4 service has at least one session.
Use a 2 second timeout around live session listing, matching `SEND_TO_AGENT` and `STOP_AGENT` validation timeouts in `send-to-agent.ts` lines 80 to 90 and `stop-agent.ts` lines 79 to 87.
#### 2.7.7 Handler behavior
1. Enforce interact access if available. Error shape mirrors `TASK_CONTROL` source at `task-control.ts` lines 109 to 115.
2. Resolve W4 service. If absent and cancellation requires live sessions, return `{ success: false, error: "SERVICE_UNAVAILABLE" }`.
3. Resolve target from `threadId`, `sessionId`, `state.codingSession.id`, `search`, most recent active thread/session, or all active sessions if `all` true.
4. Stop associated live sessions through `stopSession(sessionId)`.
5. Mark W5 sessions as `stopped` or `interrupted`; mark W5 thread as `interrupted` or `failed` with reason.
6. Callback `Canceled ${count} task(s).` or `Canceled task ${threadOrSessionId}.`
7. Return success data.
#### 2.7.8 Output shape
Single target:
```ts
{
  success: true,
  text: `Canceled task ${id}`,
  data: {
    threadId?: string,
    sessionId?: string,
    stoppedSessions: string[],
    status: "canceled" | "interrupted" | "stopped",
  },
}
```
All targets:
```ts
{
  success: true,
  text: `Canceled ${count} task(s).`,
  data: { canceledCount: number, stoppedSessions: string[] },
}
```
#### 2.7.9 Error modes
- `FORBIDDEN`
- `SERVICE_UNAVAILABLE`
- `TASK_NOT_FOUND`
- `SESSION_NOT_FOUND`
- raw error message string
#### 2.7.10 HandlerCallback usage
Callback on both success and failure, unlike `CREATE_TASK`, because cancellation is a synchronous user-facing action.
#### 2.7.11 Notes for W4 and W5
W4:
- Must stop all live sessions associated with a thread.
- If only session id is known, stop that session.
W5:
- Must resolve a thread by thread id, session id, search, or most recent active.
- Must keep history, not delete records.
**TODO verify** whether W6 should map `CANCEL_TASK` to a `TASK_CONTROL`-compatible export as well. The source has no `CANCEL_TASK` action, so @elizaos/plugin-acpx's clean action is additive.
---
## 3. Service interfaces
### 3.1 `AcpxSubprocessService` compatibility interface for W4
@elizaos/plugin-acpx's service should be implementable without PTY internals but must satisfy orchestrator-compatible call sites.
```ts
export type AcpAgentType = "claude" | "codex" | "gemini" | "aider" | "pi" | "shell" | string;
export type AcpSessionStatus =
  | "running"
  | "ready"
  | "busy"
  | "blocked"
  | "authenticating"
  | "completed"
  | "stopped"
  | "error"
  | "tool_running"
  | string;
export type AcpApprovalPreset = "readonly" | "standard" | "permissive" | "autonomous";
export interface AcpPreflightResult {
  adapter: string;
  installed: boolean;
  installCommand?: string;
  docsUrl?: string;
  auth?: { status?: "authenticated" | "unauthenticated" | "unknown" | string; detail?: string };
}
export interface AcpxSpawnSessionOptions {
  name: string;
  agentType: AcpAgentType;
  workdir?: string;
  initialTask?: string;
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
  credentials?: unknown;
  memoryContent?: string;
  approvalPreset?: AcpApprovalPreset;
  customCredentials?: Record<string, string>;
  skipAdapterAutoResponse?: boolean;
}
export interface AcpxSessionInfo {
  id: string;
  name: string;
  agentType: string;
  workdir: string;
  status: AcpSessionStatus;
  createdAt: Date;
  lastActivityAt: Date;
  metadata?: Record<string, unknown>;
}
export type AcpxSessionEventName =
  | "ready"
  | "blocked"
  | "login_required"
  | "task_complete"
  | "tool_running"
  | "stopped"
  | "error"
  | "message"
  | string;
export type AcpxSessionEventCallback = (sessionId: string, event: string, data: unknown) => void;
export interface AcpxSubprocessService {
  readonly capabilityDescription?: string;
  readonly defaultApprovalPreset: AcpApprovalPreset;
  readonly agentSelectionStrategy: "fixed" | "ranked" | "heuristic" | string;
  spawnSession(options: AcpxSpawnSessionOptions): Promise<AcpxSessionInfo>;
  sendToSession(sessionId: string, input: string): Promise<unknown>;
  sendKeysToSession(sessionId: string, keys: string | string[]): Promise<void>;
  stopSession(sessionId: string, force?: boolean): Promise<void>;
  getSession(sessionId: string): AcpxSessionInfo | undefined;
  listSessions(filter?: unknown): Promise<AcpxSessionInfo[]>;
  subscribeToOutput(sessionId: string, callback: (data: string) => void): () => void;
  getSessionOutput(sessionId: string, lines?: number): Promise<string>;
  onSessionEvent(callback: AcpxSessionEventCallback): () => void;
  resolveAgentType(selection?: {
    task?: string;
    repo?: string;
    workdir?: string;
    threadKind?: string;
    subtaskCount?: number;
    acceptanceCriteria?: string[];
  }): Promise<string>;
  checkAvailableAgents(types?: string[]): Promise<AcpPreflightResult[]>;
  getFrameworkState?(selection?: unknown): Promise<{
    configuredSubscriptionProvider?: string;
    frameworks: Array<{
      id: string;
      label: string;
      installed: boolean;
      authReady: boolean;
      subscriptionReady: boolean;
      temporarilyDisabled: boolean;
      recommended: boolean;
      reason: string;
      installCommand?: string;
      docsUrl?: string;
    }>;
    preferred: { id: string; reason: string };
  }>;
  cancelTaskCompleteAutoStop?(sessionId: string): boolean;
  isSessionLoading?(sessionId: string): Promise<boolean>;
  findSessionIdByCwd?(cwd: string): string | undefined;
}
```
Source basis:
- `PTYService` service type and lifecycle: `pty-service.ts` lines 455 to 458 and 547 to 608.
- `spawnSession`: `pty-service.ts` lines 749 to 1080.
- `sendToSession`: `pty-service.ts` lines 1111 to 1130.
- `sendKeysToSession`: `pty-service.ts` lines 1133 to 1141.
- `stopSession`: `pty-service.ts` lines 1158 to 1186.
- `defaultApprovalPreset`: `pty-service.ts` lines 1188 to 1200.
- `agentSelectionStrategy`: `pty-service.ts` lines 1202 to 1211.
- `resolveAgentType`: `pty-service.ts` lines 1240 to 1259.
- `getFrameworkState`: `pty-service.ts` lines 1261 to 1284.
- `getSession`: `pty-service.ts` lines 1286 to 1291.
- `listSessions`: `pty-service.ts` lines 1293 to 1312.
- `subscribeToOutput`: `pty-service.ts` lines 1314 to 1320.
- `getSessionOutput`: `pty-service.ts` lines 1322 to 1325.
- `onSessionEvent`: `pty-service.ts` lines 2030 to 2036.
### 3.2 Event payload contract for W4
Emit these events:
```ts
service.onSessionEvent((sessionId, event, data) => { ... });
```
Required event names:
- `ready`
- `blocked`
- `login_required`
- `task_complete`
- `tool_running`
- `stopped`
- `error`
- `message`
Source type list: `pty-types.ts` lines 119 to 128.
Required payloads:
```ts
// task_complete
{ response?: string; source?: string; session?: unknown; [key: string]: unknown }
// stopped
{ reason?: string; response?: string; source?: string; [key: string]: unknown }
// error
{ message: string; source?: string; [key: string]: unknown }
// blocked
{ prompt?: string; recentOutput?: string; [key: string]: unknown }
```
Source references:
- Hook task_complete emits `{ ...data, source: "hook" }` in `pty-service.ts` lines 1490 to 1491.
- Hook stopped emits reason/source in `pty-service.ts` lines 1519 to 1526.
- Worker exit emits error with `message`, `workerExit`, and `source` in `pty-service.ts` lines 2217 to 2220.
- Output reconciliation emits `task_complete` with `response` in `pty-service.ts` lines 2443 to 2449.
- Spawn event handler expects blocked `data.prompt` and error `data.message` in `spawn-agent.ts` lines 590 to 607.
- Nyx expects `task_complete.response`, `stopped.response`, and `error.message` in `.research/nyx-spawn-codex/spawn_codex.js` lines 281 to 296.
### 3.3 `SessionStore` interface for W5
Minimum durable interface:
```ts
export type TaskThreadStatus =
  | "open" | "active" | "waiting_on_user" | "blocked" | "validating"
  | "done" | "failed" | "archived" | "interrupted" | "canceled";
export type TaskSessionStatus =
  | "active" | "blocked" | "waiting_on_user" | "completed" | "stopped"
  | "error" | "tool_running" | "interrupted" | "canceled";
export interface CreateTaskThreadInput {
  id?: string;
  title: string;
  originalRequest: string;
  kind?: string;
  roomId?: string | null;
  worldId?: string | null;
  ownerUserId?: string | null;
  scenarioId?: string | null;
  batchId?: string | null;
  summary?: string;
  acceptanceCriteria?: string[];
  currentPlan?: Record<string, unknown>;
  lastUserTurnAt?: string | null;
  metadata?: Record<string, unknown>;
}
export interface TaskThreadRecord extends Required<Pick<CreateTaskThreadInput, "title" | "originalRequest">> {
  id: string;
  agentId?: string;
  roomId?: string | null;
  worldId?: string | null;
  ownerUserId?: string | null;
  status: TaskThreadStatus;
  kind?: string;
  summary?: string;
  currentPlan?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  archivedAt?: string | null;
}
export interface RegisterTaskSessionInput {
  threadId: string;
  sessionId: string;
  framework: string;
  label: string;
  originalTask: string;
  workdir: string;
  repo?: string;
  providerSource?: string | null;
  status?: TaskSessionStatus;
  decisionCount?: number;
  autoResolvedCount?: number;
  registeredAt?: number;
  lastActivityAt?: number;
  idleCheckCount?: number;
  taskDelivered?: boolean;
  completionSummary?: string | null;
  lastSeenDecisionIndex?: number;
  lastInputSentAt?: number | null;
  stoppedAt?: number | null;
  metadata?: Record<string, unknown>;
}
export interface TaskSessionRecord extends RegisterTaskSessionInput {
  id: string;
  agentId?: string;
  status: TaskSessionStatus;
  registeredAt: number;
  lastActivityAt: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export interface SessionStore {
  createTaskThread(input: CreateTaskThreadInput): Promise<TaskThreadRecord>;
  updateTaskThread(threadId: string, patch: Partial<TaskThreadRecord>): Promise<TaskThreadRecord>;
  getTaskThread(threadId: string): Promise<TaskThreadRecord | null>;
  listTaskThreads(options?: {
    includeArchived?: boolean;
    status?: TaskThreadStatus;
    statuses?: TaskThreadStatus[];
    roomId?: string;
    worldId?: string;
    ownerUserId?: string;
    search?: string;
    limit?: number;
  }): Promise<TaskThreadRecord[]>;
  registerTaskSession(input: RegisterTaskSessionInput): Promise<TaskSessionRecord>;
  updateTaskSession(sessionId: string, patch: Partial<TaskSessionRecord>): Promise<TaskSessionRecord | null>;
  getTaskSession(sessionId: string): Promise<TaskSessionRecord | null>;
  listTaskSessions(threadId?: string): Promise<TaskSessionRecord[]>;
  findThreadIdBySessionId(sessionId: string): Promise<string | null>;
  recordTranscript(input: {
    threadId: string;
    sessionId: string;
    direction: "stdout" | "stderr" | "stdin" | "keys" | "system";
    content: string;
    timestamp?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  recordEvent(input: {
    threadId: string;
    sessionId?: string | null;
    eventType: string;
    timestamp?: number;
    summary?: string;
    data?: Record<string, unknown>;
  }): Promise<void>;
}
```
Source basis:
- `CreateTaskThreadInput`: `task-registry.ts` lines 345 to 360.
- `RegisterTaskSessionInput`: `task-registry.ts` lines 362 to 383.
- `UpdateTaskSessionInput`: `task-registry.ts` lines 385 to 397.
- `UpdateTaskThreadInput`: `task-registry.ts` lines 399 to 408.
- `RecordTaskEventInput`: `task-registry.ts` lines 422 to 429.
- `RecordTaskTranscriptInput`: `task-registry.ts` lines 442 to 449.
- Thread/session status normalization: `task-registry.ts` lines 715 to 743.
### 3.4 Status mapping
@elizaos/plugin-acpx statuses must map to orchestrator strings:
- Running acpx process maps to `running` or `active` for store, and a session status acceptable to callers.
- Blocked maps to `blocked`.
- Waiting for auth maps to `authenticating` or event `login_required`.
- Completed response maps first to `task_complete` event, then eventual session `stopped` or `completed`.
- Error maps to `error` with `message`.
- User cancellation maps to `stopped` event and store `interrupted` or `canceled`.
---
## 4. Type exports from `index.ts`
@elizaos/plugin-acpx should mirror the exports that third-party code is likely to import, while replacing internals with acpx equivalents.
### 4.1 Plugin exports
Export:
```ts
export const acpPlugin: Plugin;
export const taskAgentPlugin = acpPlugin;
export const codingAgentPlugin = acpPlugin;
export const agentOrchestratorPlugin = acpPlugin;
export default acpPlugin;
```
Orchestrator source:
- `taskAgentPlugin`: `index.ts` lines 36 to 77.
- aliases and default: `index.ts` lines 79 to 82.
### 4.2 Action exports
Export:
```ts
export { createTaskAction, startCodingTaskAction } from "./actions/create-task";
export { spawnAgentAction, spawnTaskAgentAction } from "./actions/spawn-agent";
export { sendToAgentAction, sendToTaskAgentAction } from "./actions/send-to-agent";
export { listAgentsAction, listTaskAgentsAction } from "./actions/list-agents";
export { stopAgentAction, stopTaskAgentAction } from "./actions/stop-agent";
export { cancelTaskAction } from "./actions/cancel-task";
```
Orchestrator source:
- `listAgentsAction`, `listTaskAgentsAction`: `index.ts` lines 98 to 101.
- `sendToAgentAction`, `sendToTaskAgentAction`: `index.ts` lines 104 to 107.
- `spawnAgentAction`, `spawnTaskAgentAction`: `index.ts` lines 108 to 111.
- `startCodingTaskAction`: `index.ts` line 113.
- `stopAgentAction`, `stopTaskAgentAction`: `index.ts` line 114.
### 4.3 Service exports
Export:
```ts
export { AcpxSubprocessService } from "./services/acpx-subprocess-service";
export { AcpSessionStore } from "./services/session-store";
export { getCoordinator } from "./services/compat";
export { AcpxSubprocessService as PTYService } from "./services/acpx-subprocess-service";
```
Reason:
- External code may import `PTYService` from orchestrator. Orchestrator exports it in `index.ts` line 134.
- @elizaos/plugin-acpx can alias `PTYService` to its compatibility facade.
### 4.4 Type exports
Mirror type names where possible:
```ts
export type {
  AcpAgentType as CodingAgentType,
  AcpxServiceConfig as PTYServiceConfig,
  AcpxSessionEventName as SessionEventName,
  AcpxSessionInfo as SessionInfo,
  AcpxSpawnSessionOptions as SpawnSessionOptions,
  AcpxSessionEventCallback as SessionEventCallback,
};
```
Orchestrator exports these PTY types in `index.ts` lines 126 to 132 and defines them in `pty-types.ts` lines 18 to 136.
Adapter types from `coding-agent-adapters` may not exist in @elizaos/plugin-acpx. Recommended compatibility exports:
```ts
export type AdapterType = "claude" | "codex" | "gemini" | "aider";
export type ApprovalPreset = "readonly" | "standard" | "permissive" | "autonomous";
export type AgentCredentials = Record<string, unknown>;
export type PreflightResult = AcpPreflightResult;
```
Orchestrator re-exports adapter types in `index.ts` lines 84 to 96.
### 4.5 Provider exports
Optional but recommended:
```ts
export { acpActionExamplesProvider as codingAgentExamplesProvider };
export { acpActiveWorkspaceContextProvider as activeWorkspaceContextProvider };
```
Orchestrator providers are registered in `index.ts` lines 72 to 76 and implemented in:
- `action-examples.ts` lines 21 to 27 and 45 to 70.
- `active-workspace-context.ts` lines 60 to 67 and 111 to 247.
---
## 5. Memory message conventions
### 5.1 Spawn/create chat-visible messages
`CREATE_TASK` success should not callback a routine launch message and should return `text: ""`.
Source:
- No launch chatter: `coding-task-handlers.ts` lines 700 to 703.
- Empty success text rationale: `coding-task-handlers.ts` lines 1096 to 1101.
- Success return: `coding-task-handlers.ts` lines 1118 to 1122.
`SPAWN_AGENT` success should similarly avoid duplicate user-facing chatter unless no async synthesis exists.
### 5.2 Failure messages
Create/spawn launch failures must be user-friendly and concise.
Orchestrator generates a character-voice failure message with constraints:
- plain language
- no stack trace dump
- keep concrete blocker
- 1 to 3 short sentences
- do not claim task ran or succeeded
Source: `coding-task-handlers.ts` lines 282 to 305.
@elizaos/plugin-acpx can use deterministic text instead of an LLM:
```txt
I couldn't start the task agent: <short blocker>. Nothing ran yet.
```
For partial multi-agent failure:
```txt
I started some task agents, but <n> failed to launch: <short blockers>.
```
### 5.3 Completion messages
Direct event handlers should not post per-agent `task_complete` messages in normal `CREATE_TASK` flow.
Source:
- `registerSessionEvents` avoids blocked and task_complete chat messages in `coding-task-helpers.ts` lines 158 to 175.
- The SwarmCoordinator or async streamer owns final synthesis.
@elizaos/plugin-acpx event convention:
- Emit `task_complete` event with `response` for in-process consumers.
- If W6 has a chat callback path for direct sessions, callback final output only once.
- Do not echo the original task as the final result.
### 5.4 Error messages
`registerSessionEvents` emits error callback only when direct callback path is active:
```txt
Agent "<label>" encountered an error: <message>
```
Source: `coding-task-helpers.ts` lines 176 to 180.
`SPAWN_AGENT` non-coordinator error convention:
```txt
Task agent encountered an error: <message>
```
Source: `spawn-agent.ts` lines 603 to 608.
### 5.5 Blocked messages
`SPAWN_AGENT` non-coordinator blocked convention:
```txt
Task agent is waiting for input: <prompt>
```
Source: `spawn-agent.ts` lines 589 to 593.
`CREATE_TASK` should generally suppress blocked messages because auto-resolution or coordinator/`AcpxSubprocessService` supervisor owns them.
Source: `coding-task-helpers.ts` lines 158 to 163.
### 5.6 Message metadata
When creating synthetic or stored messages, preserve:
- `message.id`
- `message.roomId`
- `message.worldId`
- `message.entityId`
- `message.agentId`
- `message.content.source`
Nyx synthetic message sets these fields in `.research/nyx-spawn-codex/spawn_codex.js` lines 216 to 243.
---
## 6. Configuration env vars
@elizaos/plugin-acpx should support its own env vars and compatibility aliases.
### 6.1 @elizaos/plugin-acpx primary vars
```txt
ELIZA_ACP_CLI
ELIZA_ACP_DEFAULT_AGENT
ELIZA_ACP_WORKDIR_ROOT
ELIZA_ACP_ALLOWED_WORKDIRS
ELIZA_ACP_SANDBOX
ELIZA_ACP_DEFAULT_APPROVAL_PRESET
ELIZA_ACP_AGENT_SELECTION_STRATEGY
ELIZA_ACP_MAX_SESSIONS
ELIZA_ACP_SESSION_TIMEOUT_MS
ELIZA_ACP_CODEX_MODEL
ELIZA_ACP_CLAUDE_MODEL
ELIZA_ACP_GEMINI_MODEL
ELIZA_ACP_AIDER_MODEL
```
Recommended meanings:
- `ELIZA_ACP_CLI`: path to `acpx` executable or wrapper.
- `ELIZA_ACP_DEFAULT_AGENT`: default framework, for example `codex`.
- `ELIZA_ACP_WORKDIR_ROOT`: scratch workspace root.
- `ELIZA_ACP_ALLOWED_WORKDIRS`: comma-separated allowlist.
- `ELIZA_ACP_SANDBOX`: `on` by default, `off|false|0` disables app-level allowlist.
- `ELIZA_ACP_DEFAULT_APPROVAL_PRESET`: readonly, standard, permissive, autonomous.
- `ELIZA_ACP_AGENT_SELECTION_STRATEGY`: fixed or ranked.
- `ELIZA_ACP_MAX_SESSIONS`: maximum concurrent sessions.
- model vars: per-agent model defaults passed to acpx CLI.
### 6.2 Orchestrator compatibility vars
Support these aliases:
```txt
PTY_SERVICE_CONFIG
CODING_WORKSPACE_CONFIG
PARALLAX_DEFAULT_AGENT_TYPE
PARALLAX_AGENT_SELECTION_STRATEGY
PARALLAX_DEFAULT_APPROVAL_PRESET
PARALLAX_CODING_DIRECTORY
CODING_AGENT_ALLOWED_WORKDIRS
CODING_AGENT_SANDBOX
PARALLAX_LLM_PROVIDER
PARALLAX_CLAUDE_MODEL_POWERFUL
PARALLAX_CLAUDE_MODEL_FAST
PARALLAX_CODEX_MODEL_POWERFUL
PARALLAX_CODEX_MODEL_FAST
PARALLAX_GEMINI_MODEL_POWERFUL
PARALLAX_GEMINI_MODEL_FAST
PARALLAX_AIDER_MODEL_POWERFUL
PARALLAX_AIDER_MODEL_FAST
CUSTOM_CREDENTIAL_KEYS
ANTHROPIC_API_KEY
OPENAI_API_KEY
GOOGLE_GENERATIVE_AI_API_KEY
GOOGLE_API_KEY
CLAUDE_CODE_OAUTH_TOKEN
CODEX_HOME
SERVER_PORT
MILADY_STATE_DIR
ELIZA_STATE_DIR
ELIZA_NAMESPACE
MILADY_CONFIG_PATH
ELIZA_CONFIG_PATH
```
Source references:
- README config shows `PTY_SERVICE_CONFIG`, `CODING_WORKSPACE_CONFIG`, `PARALLAX_DEFAULT_AGENT_TYPE`, and `PARALLAX_AGENT_SELECTION_STRATEGY` in README lines 166 to 192.
- Config file env reader uses `MILADY_STATE_DIR`, `ELIZA_STATE_DIR`, and `ELIZA_NAMESPACE` in `config-env.ts` lines 17 to 24.
- Workdir scratch root uses `PARALLAX_CODING_DIRECTORY` in `coding-task-helpers.ts` lines 62 to 80.
- Sandbox uses `CODING_AGENT_SANDBOX`, `CODING_AGENT_ALLOWED_WORKDIRS`, and `PARALLAX_CODING_DIRECTORY` in `spawn-agent.ts` lines 311 to 379.
- Approval preset uses `PARALLAX_DEFAULT_APPROVAL_PRESET` in `pty-service.ts` lines 1188 to 1200.
- Selection strategy uses `PARALLAX_AGENT_SELECTION_STRATEGY` in `pty-service.ts` lines 1202 to 1211.
- Default agent type uses `PARALLAX_DEFAULT_AGENT_TYPE` in `pty-service.ts` lines 1213 to 1238.
- Model preference setting keys are in `task-agent-frameworks.ts` lines 202 to 222.
- Default model prefs are `claude-opus-4-7`, `gpt-5.5`, and `gpt-5.5-mini` in `task-agent-frameworks.ts` lines 224 to 232.
- Auth env probes are in `task-agent-frameworks.ts` lines 480 to 508.
- `CODEX_HOME` is read in `pty-service.ts` lines 271 to 275.
- `SERVER_PORT` defaulting is in `pty-service.ts` lines 311 to 316.
### 6.3 Precedence
Recommended precedence:
1. Explicit action params.
2. @elizaos/plugin-acpx env vars.
3. Orchestrator compatibility env vars or runtime settings.
4. Config-file env section when available.
5. Built-in defaults.
Orchestrator often reads config file first, then runtime, then process env. Examples:
- `readConfigEnvKey` reads config env in `config-env.ts` lines 32 to 36.
- `safeGetSetting` checks config first, then runtime in `task-agent-frameworks.ts` lines 274 to 293.
- Scratch dir checks runtime, config, then process env in `coding-task-helpers.ts` lines 62 to 69.
@elizaos/plugin-acpx may choose a simpler precedence, but document it in code and tests.
---
## 7. Explicitly not matched
@elizaos/plugin-acpx must not spend migration time on these orchestrator surfaces unless a later requirement adds them.
### 7.1 Workspace actions
Do not implement full:
- `PROVISION_WORKSPACE`
- `FINALIZE_WORKSPACE`
- `CodingWorkspaceService`
- git worktrees
- commits
- pushes
- PR creation
Source: README lists workspace features in README lines 129 to 164 and canonical workspace actions in README lines 73 to 74.
@elizaos/plugin-acpx requirement is only:
- `CREATE_TASK` can accept `repo` and either clone minimally or return `WORKSPACE_SERVICE_UNAVAILABLE`.
- For Nyx, `workdir` scratch is sufficient.
### 7.2 SwarmCoordinator internals
Do not match:
- full decision loop
- pending confirmations
- LLM validation
- shared decision prompts
- idle watchdog
- mailbox
- graph planner
Orchestrator exports these in `index.ts` lines 135 to 155, but third-party action compatibility does not require them.
### 7.3 Frontend and API routes
Do not match:
- xterm views
- PTY console bridge
- `/api/coding-agents/*` routes
- route handlers exported from `index.ts` lines 118 to 123
### 7.4 Subscription-aware picker
Do not match Milady subscription detection:
- `~/.milady/milady.json` subscriptionProvider
- Anthropic/OpenAI subscription scoring
- cloud proxy key detection
- account pool failover
Source: README lines 12, 28 to 34, and 194 to 206; framework code in `task-agent-frameworks.ts` lines 427 to 455 and 620 to 649.
@elizaos/plugin-acpx should implement deterministic default selection.
### 7.5 Skill bridge and structured proof bridge
Do not match:
- `MILADY_SKILLS_MANIFEST`
- `USE_SKILL` bridge
- structured proof bridge
- app/plugin validator sentinels
Source examples:
- Skill manifest spawn env in `coding-task-handlers.ts` lines 947 to 963.
- Structured proof bridge startup in `pty-service.ts` lines 599 to 605.
### 7.6 Task history, sharing, issues
Do not match unless requested:
- `TASK_HISTORY`
- `TASK_SHARE`
- `MANAGE_ISSUES`
They are registered by orchestrator in `index.ts` lines 59 to 67, but not part of the six-action @elizaos/plugin-acpx parity target.
---
## 8. Nyx `spawn_codex` compatibility
### 8.1 Consumer contract
Nyx's tool does not import a class directly. It uses runtime surfaces:
1. `runtime.actions.find(a => a.name === "CREATE_TASK")`.
2. Fallback search through `similes` for `CREATE_TASK`.
3. `runtime.getService("PTY_SERVICE")`.
4. `ptyService.onSessionEvent`.
5. `CREATE_TASK.handler(...)`.
6. `ActionResult.data.agents[].sessionId`.
7. Session events until terminal or settled.
Source: `.research/nyx-spawn-codex/spawn_codex.js` lines 83 to 90, 205 to 214, 117 to 150, and 258 to 363.
### 8.2 Action invocation shape
Nyx calls:
```js
action.handler(
  runtime,
  syntheticMessage,
  undefined,
  {
    parameters: {
      task: input.task,
      agentType: "codex",
      ...(input.model ? { model: input.model } : {}),
    },
  },
  captureCallback,
)
```
Source: `.research/nyx-spawn-codex/spawn_codex.js` lines 117 to 124.
Synthetic message content contains:
```js
{
  ...parentContent,
  text: fields.task,
  task: fields.task,
  agentType: "codex",
  workdir: fields.workdir,
  source: "native-reasoning:spawn_codex",
  model?: fields.model,
}
```
Source: `.research/nyx-spawn-codex/spawn_codex.js` lines 216 to 227.
@elizaos/plugin-acpx must read `workdir` from message content even though `options.parameters` does not include it.
### 8.3 Required `CREATE_TASK` result for Nyx
If action throws, Nyx returns error. @elizaos/plugin-acpx should not throw for expected failures.
If no result, Nyx returns error.
If `success === false`, Nyx builds a failure reason from `text`, `error`, and callback texts.
If success but no session ids, Nyx returns error.
Source: `.research/nyx-spawn-codex/spawn_codex.js` lines 126 to 149.
Required success:
```ts
{
  success: true,
  text: "",
  data: {
    agents: [
      {
        sessionId: "pty-or-acp-id",
        agentType: "codex",
        workdir: input.workdir,
        label: string,
        status: string,
      },
    ],
    suppressActionResultClipboard: true,
  },
}
```
### 8.4 Required event stream for Nyx
Nyx subscribes before invoking the action, buffers untracked events, then calls `track(sessionIds)` after action result.
@elizaos/plugin-acpx must emit events through `onSessionEvent` in-process.
Nyx ingests:
```js
if (event === "task_complete") {
  const resp = typeof payload.response === "string" ? payload.response : "";
  if (resp) state.latestResponse = resp;
  state.taskCompleteAt = Date.now();
} else if (event === "stopped") {
  if (typeof payload.response === "string" && payload.response) {
    state.latestResponse = payload.response;
  }
  state.terminal = true;
} else if (event === "error") {
  const msg = typeof payload.message === "string" ? payload.message : "unknown";
  errors.push(`[${sid}] ${msg}`);
  state.terminal = true;
}
```
Source: `.research/nyx-spawn-codex/spawn_codex.js` lines 278 to 298.
Therefore @elizaos/plugin-acpx must:
1. Emit `task_complete` with `data.response` when the acpx subagent produces a final answer.
2. Emit `stopped` after process exits or is auto-stopped.
3. Include `data.response` on `stopped` if no prior `task_complete` was emitted and final output exists.
4. Emit `error` with `data.message` on failures.
5. Ensure event emission happens after or near spawn, but Nyx buffers events before tracking, so early `ready` is safe.
### 8.5 Timeout and settle implications
Nyx treats all sessions as terminal when:
- all sessions have `stopped` or `error`, or
- all sessions emitted at least one `task_complete` and 1500 ms have elapsed, or
- hard timeout trips.
Source: `.research/nyx-spawn-codex/spawn_codex.js` lines 301 to 360.
@elizaos/plugin-acpx should emit `task_complete` promptly and then `stopped` soon after to avoid waiting for timeout.
### 8.6 Framework downgrade note
Nyx detects downgrade:
```js
const downgrade = agentRecords.find((a) => a.agentType && a.agentType !== "codex");
```
Source: `.research/nyx-spawn-codex/spawn_codex.js` lines 151 to 154.
@elizaos/plugin-acpx should honor `agentType: "codex"` exactly when supplied. Do not silently route Nyx to another framework unless codex is unavailable and the action is still considered success. If downgraded, set `agentType` to actual framework so Nyx can report it.
### 8.7 Callback capture
Nyx passes a callback that buffers text and returns `[]`.
Source: `.research/nyx-spawn-codex/spawn_codex.js` lines 93 to 101.
@elizaos/plugin-acpx must not assume callback output is chat-visible or that it returns `void`.
### 8.8 Workdir contract
Nyx default workdir is `/workspace/tasks/<timestamp>-<uuid8>`.
Source: `.research/nyx-spawn-codex/spawn_codex.js` lines 34 to 36 and 185 to 195.
@elizaos/plugin-acpx must:
- create the workdir if absent
- pass it to subprocess cwd
- return it unchanged in `data.agents[0].workdir`
### 8.9 Model contract
Nyx forwards optional `model` and says it should set `OPENAI_MODEL` via orchestrator.
Source: `.research/nyx-spawn-codex/spawn_codex.js` lines 64 to 68 and 117 to 123.
Orchestrator source does not visibly consume `model` in `CREATE_TASK` handler sections read. @elizaos/plugin-acpx should implement this cleanly:
- If `agentType === "codex"` and `model` provided, set `OPENAI_MODEL=model` in subprocess env or translate to acpx CLI model flag.
- Preserve `metadata.modelPrefs` if W6 uses model prefs.
**TODO verify** exact orchestrator model forwarding path for `model` because the researched `CREATE_TASK` handler did not show direct `model` extraction.
---
## 9. Test strategy
### 9.1 Unit tests for action metadata
For each action assert:
- canonical `name`
- all aliases
- parameters match this spec
- `suppressPostActionContinuation` true for `CREATE_TASK` and `SPAWN_AGENT`
- validate false when service missing
- validate true on explicit payload
Specific cases:
- `CREATE_TASK` explicit payload accepts `task`, `repo`, `workdir`, `agents`, `agentType`.
- `SPAWN_AGENT` explicit payload accepts `task`, `workdir`, `agentType`.
- `SEND_TO_AGENT` and `STOP_AGENT` validate time out quickly if service list hangs.
### 9.2 Unit tests for input extraction
Test precedence:
1. `options.parameters.task` beats `message.content.task`.
2. `message.content.workdir` is honored for Nyx.
3. `task` falls back to `content.text` for `CREATE_TASK`.
4. `input` falls back to `task` for `SEND_TO_AGENT`.
5. `sessionId` falls back to `state.codingSession.id`.
6. no `sessionId` falls back to newest session.
### 9.3 Unit tests for output shape
`CREATE_TASK` success:
- `success: true`
- `text: ""`
- `data.agents` array
- `data.agents[0].sessionId` non-empty
- `data.suppressActionResultClipboard === true`
`CREATE_TASK` partial failure:
- `success: false`
- `text` non-empty
- `data.agents` includes failed record with `sessionId: ""`, `status: "failed"`, and `error`
`SEND_TO_AGENT`:
- keys case shape
- input case shape
- no input returns `NO_INPUT`
`STOP_AGENT`:
- no sessions no-op
- one session stopped data shape
- all sessions stopped count
`LIST_AGENTS`:
- empty case includes `preferredTaskAgent`
- non-empty case maps dates to ISO strings
`CANCEL_TASK`:
- stops sessions and marks store
- returns stopped session ids
### 9.4 Unit tests for events
Use fake acpx process adapter.
Assert:
- `onSessionEvent` returns unsubscribe.
- events before Nyx `track()` are still received by Nyx because subscription is active.
- `task_complete` includes `response`.
- `stopped` includes `response` if needed.
- `error` includes `message`.
- `stopSession()` emits `stopped`.
### 9.5 Integration tests for Nyx contract
Port `.research/nyx-spawn-codex/spawn_codex.js` behavior into tests:
1. Build runtime with `@elizaos/plugin-acpx` only.
2. Find `CREATE_TASK` by name.
3. Find `PTY_SERVICE`.
4. Invoke handler with synthetic message:
   ```js
   { task: "write hello", workdir: tmpdir, agentType: "codex" }
   ```
5. Fake acpx process emits `task_complete` with response.
6. Assert tool transcript contains response and `is_error: false`.
7. Failure case: action returns success false, assert tool error.
8. No session ids case, assert tool error.
9. Timeout case, assert tool timeout error.
### 9.6 Integration tests for real acpx CLI
If `ELIZA_ACP_CLI` is configured:
- spawn a codex task in temp dir
- ask it to write a file
- wait for `task_complete`
- assert file exists
- assert `LIST_AGENTS` reports status
- `STOP_AGENT` cleans up
Skip when CLI not available.
### 9.7 E2E tests
Create an Eliza runtime with `@elizaos/plugin-acpx`.
Scenarios:
1. User asks a multi-step coding/research task. Planner calls `CREATE_TASK`. No duplicate post-action continuation.
2. User asks to send follow-up to the running agent. Planner calls `SEND_TO_AGENT`.
3. User asks what is running. Planner calls `LIST_AGENTS`.
4. User asks to cancel. Planner calls `CANCEL_TASK` or `STOP_AGENT`.
5. User asks a simple reply. acpx validation does not force task spawn.
### 9.8 Regression tests for ugly source behavior we intentionally preserve
Preserve:
- `CREATE_TASK` success `text` is empty.
- `CREATE_TASK.data.suppressActionResultClipboard` is true.
- no routine launch callback.
- `data.agents[].sessionId` remains the stable external id.
- `agentType: "codex"` from Nyx is honored.
Do not preserve:
- Milady subscription scoring.
- Swarm LLM failure-message generation.
- heavy workspace git service.
---
## Appendix A. Source cross-reference checklist
1. README purpose and features: README lines 3 to 14.
2. README canonical actions: README lines 64 to 76.
3. README config: README lines 166 to 192.
4. Package peer dependencies: package lines 34 to 38.
5. Package runtime deps: package lines 49 to 54.
6. Plugin action registration: `index.ts` lines 51 to 67.
7. Plugin providers: `index.ts` lines 72 to 76.
8. Plugin aliases/default: `index.ts` lines 79 to 82.
9. Action exports: `index.ts` lines 97 to 117.
10. Type/service exports: `index.ts` lines 125 to 164.
11. `SPAWN_AGENT` aliases: `spawn-agent.ts` lines 114 to 124.
12. `SPAWN_AGENT` validation: `spawn-agent.ts` lines 174 to 196.
13. `SPAWN_AGENT` service error: `spawn-agent.ts` lines 215 to 225.
14. `SPAWN_AGENT` workdir sandbox: `spawn-agent.ts` lines 311 to 379.
15. `SPAWN_AGENT` spawn call: `spawn-agent.ts` lines 523 to 543.
16. `SEND_TO_AGENT` aliases: `send-to-agent.ts` lines 27 to 35.
17. `SEND_TO_AGENT` validation timeout: `send-to-agent.ts` lines 80 to 90.
18. `SEND_TO_AGENT` output shapes: `send-to-agent.ts` lines 178 to 182 and 244 to 254.
19. `LIST_AGENTS` output data: `list-agents.ts` lines 219 to 245.
20. `STOP_AGENT` all mode: `stop-agent.ts` lines 127 to 162.
21. `STOP_AGENT` single mode: `stop-agent.ts` lines 164 to 223.
22. `CREATE_TASK` aliases: `start-coding-task.ts` lines 289 to 298.
23. `CREATE_TASK` parameters: `start-coding-task.ts` lines 659 to 772.
24. `CREATE_TASK` validation: `start-coding-task.ts` lines 381 to 407.
25. `CREATE_TASK` dispatch: `start-coding-task.ts` lines 625 to 657.
26. `handleMultiAgent` parse and cap: `coding-task-handlers.ts` lines 669 to 689.
27. `handleMultiAgent` no launch chatter: `coding-task-handlers.ts` lines 700 to 703.
28. `handleMultiAgent` result record type: `coding-task-handlers.ts` lines 746 to 755.
29. `handleMultiAgent` success return: `coding-task-handlers.ts` lines 1118 to 1122.
30. `PTY` types: `pty-types.ts` lines 18 to 136.
31. `PTYService` spawn: `pty-service.ts` lines 749 to 1080.
32. `PTYService` send/keys/stop: `pty-service.ts` lines 1111 to 1186.
33. `PTYService` event subscription: `pty-service.ts` lines 2030 to 2036.
34. `PTYService` emit callback path: `pty-service.ts` lines 2119 to 2181.
35. Nyx lookup and invocation: `.research/nyx-spawn-codex/spawn_codex.js` lines 83 to 150.
36. Nyx event ingestion: `.research/nyx-spawn-codex/spawn_codex.js` lines 258 to 363.
