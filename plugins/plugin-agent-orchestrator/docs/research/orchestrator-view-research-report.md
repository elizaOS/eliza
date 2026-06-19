# Orchestrator View Research Report

Date: 2026-05-30

## High-Level Goal

Build an `/orchestrator` experience for ElizaOS that treats work as durable tasks, not disposable chats. The main orchestrator room should remain open indefinitely, create and fork task rooms from natural language or explicit UI controls, provision Claude/Codex/OpenCode/Eliza sub-agents using persistent `/goal`-style prompts, and never present a task as done until acceptance criteria, verification, and final handoff are complete. The UI must expose task status, room messages, sub-agent activity, model/provider/subscription selection, token spend, pause/resume/archive/delete controls, secure and local-insecure secret collection, voice/chat-controllable view actions, searchable paginated history, remote/mobile access, and route/action-specific automated plus screenshot/manual verification.

## Current Status And Remaining Work

This report started as a research snapshot. The current branch now has a first durable `/api/orchestrator/*` task surface, `/orchestrator` plugin view registration, task-thread client methods backed by real routes, mandatory goal wrappers for direct coding-agent spawn/send paths, usage aggregation from ACP result usage, and dispatcher-level credential bridge wiring. Treat older unsupported-feature statements below as historical context when they conflict with this section.

Remaining work:

- Replace caller-supplied validation with registered verification hooks that collect durable evidence before `done`.
- Add end-to-end coverage for every declared orchestrator view capability, TUI endpoint, and task lifecycle mutation.
- Add screenshot/manual review for the orchestrator UI and any shared cloud frontend changes before declaring UI work complete.
- Finish provider/subscription settings cleanup and internationalize every new orchestrator string.
- Prove remote/mobile access against a local desktop agent and against cloud-connected agents.

## Executive Findings

The repository already has three partial layers that should be joined rather than rebuilt from scratch:

- `plugins/plugin-agent-orchestrator` owns ACP subprocess sessions, agent selection, routing, workspace lifecycle, sub-agent progress, and task actions.
- `plugins/plugin-task-coordinator` owns a plugin view bundle at `/task-coordinator` plus task/session panels, but it is currently wired to mostly stubbed task-thread client methods.
- `packages/ui` owns the app shell, dynamic plugin views, built-in `/tasks` page, chat sidebar widgets, task-coordinator slots, route resolution, i18n, and local smoke coverage.

The main blocker is that the desired product model is "task thread with room, messages, sub-agents, goal, telemetry, and lifecycle", while the implemented backend model exposed to UI is mostly "ACP session list". Typed task-thread shapes exist in `packages/ui/src/api/client-types-cloud.ts`, and `CodingAgentTasksPanel` already expects thread APIs, but `ElizaClient` returns empty/null for task-thread list/detail/archive/reopen. The `/api/coding-agents/metrics` route returns `{}`, and no route currently exposes per-agent token usage.

## Current Backend State

`plugin-agent-orchestrator` registers raw HTTP routes for coding agents, workspace, and issues, but not task-thread coordinator APIs. The route table includes `/api/coding-agents`, `/api/coding-agents/spawn`, `/api/coding-agents/metrics`, per-agent send/stop/output, parent-context/memory/active-workspaces, workspace, and issue routes in `plugins/plugin-agent-orchestrator/src/setup-routes.ts:81`.

The active session routes can list sessions, spawn sessions, send input, stop sessions, and read output. Relevant gaps:

- `/api/coding-agents/metrics` currently returns `{}` in `plugins/plugin-agent-orchestrator/src/api/agent-routes.ts:274`.
- `/api/coding-agents/workspace-files` returns an empty file list in `plugins/plugin-agent-orchestrator/src/api/agent-routes.ts:337`.
- `/api/coding-agents/settings` does expose preferred framework, configured subscription provider, and framework availability in `plugins/plugin-agent-orchestrator/src/api/agent-routes.ts:391`.
- `/api/coding-agents` lists raw ACP sessions from `ctx.acpService.listSessions()` in `plugins/plugin-agent-orchestrator/src/api/agent-routes.ts:441`.
- `/api/coding-agents/spawn` passes `initialTask: taskText` directly in `plugins/plugin-agent-orchestrator/src/api/agent-routes.ts:553`; it does not enforce a goal wrapper on direct API spawns.
- `/api/coding-agents/:id/send` passes user input directly to `sendToSession` in `plugins/plugin-agent-orchestrator/src/api/agent-routes.ts:610`; it does not enforce a goal wrapper on direct sends.
- Credential bridge routes exist, but the main dispatcher does not import or call `handleBridgeRoutes`; the bridge module itself still says to hook it from `routes.ts` in `plugins/plugin-agent-orchestrator/src/api/bridge-routes.ts:230`. This blocks secure credential retrieval from the current route surface.

The action path is richer. `TASKS_SPAWN_AGENT` constructs task-room/worktree-room metadata, route hints, initial task metadata, and swarming instructions. It tells agents to keep working until finished or blocked in `plugins/plugin-agent-orchestrator/src/actions/tasks.ts:375`, spawns with `initialTask: taskWithRouteHints` in `plugins/plugin-agent-orchestrator/src/actions/tasks.ts:723`, and records session metadata including task room, worktree route, label, source, and `initialTask` in `plugins/plugin-agent-orchestrator/src/actions/tasks.ts:729`. However, it intentionally returns `continueChain: false` immediately after spawn in `plugins/plugin-agent-orchestrator/src/actions/tasks.ts:762` so the parent turn ends while the sub-agent works asynchronously. That is the opposite of the requested "orchestrator does not return until goal completion" behavior unless the new task/goal runner adds a durable task status contract outside the single chat turn.

`TASKS_SEND_TO_AGENT` also sends direct follow-up text unless it is reacting to a routed incomplete completion, where it builds a stronger "continue original task" follow-up in `plugins/plugin-agent-orchestrator/src/actions/tasks.ts:856`. This should become a mandatory `/goal` envelope for Claude/Codex/OpenCode/Eliza prompts, not a best-effort retry phrase.

## Current UI State

`plugin-task-coordinator` already declares a GUI view at `/task-coordinator`, an XR view at `/task-coordinator`, and a TUI view at `/task-coordinator/tui` in `plugins/plugin-task-coordinator/src/index.ts:6`. The GUI exports `CodingAgentTasksPanel`; the TUI exposes capabilities for listing sessions, listing task threads, opening a thread, stopping a session, and refreshing.

`packages/ui` can route dynamic plugin views by matching `ViewRegistryEntry.path` and loading their `bundleUrl` through `DynamicViewLoader` in `packages/ui/src/App.tsx:451`. Built-in static views include `tasks`, which renders `TasksPageView` in `packages/ui/src/App.tsx:542`. The navigation type and path map include `tasks`, but not `orchestrator`, in `packages/ui/src/navigation/index.ts:44` and `packages/ui/src/navigation/index.ts:318`.

`packages/ui/src/slots/task-coordinator-slots.tsx` deliberately keeps app-core from importing the plugin directly and instead lets plugins register task-coordinator components into slots. This is the right pattern to preserve if `/orchestrator` remains a frontend plugin view, but it also means `plugin-agent-orchestrator` cannot simply add a React file without introducing a browser build and a view-registration story.

The current task panel is a useful seed, but not enough for the requested view. `CodingAgentTasksPanel` polls `client.listCodingAgentTaskThreads` every 5 seconds in `plugins/plugin-task-coordinator/src/CodingAgentTasksPanel.tsx:680`, loads selected thread details, and has archive/reopen handlers in `plugins/plugin-task-coordinator/src/CodingAgentTasksPanel.tsx:802`. The client methods behind those calls currently return empty/null/false in `packages/ui/src/api/client-agent.ts:3403`, so local task rooms and history are not truly available.

Chat sidebar widgets are registered for app runs and activity under `agent-orchestrator` in `packages/ui/src/widgets/registry.ts:67`, but they are not the requested full-room orchestration surface.

There is no first-class `/orchestrator` route in desktop or cloud today. Desktop has a built-in `tasks` tab and `/apps/tasks` surface, while `plugin-task-coordinator` registers `/task-coordinator`. Cloud is further behind for this specific feature: inline cloud agent chat is intentionally not wired yet, and public cloud chat is character-room text streaming rather than orchestrator/task-room state.

Slash-chat support is also not built in for this product yet. Existing slash behavior is tied to saved/custom action expansion, not built-in `/orchestrator`, `/task`, `/spawn`, or `/tasks` commands. The first version should decide whether slash commands call the orchestrator API directly or translate into planner-visible task requests.

## Data Model Required

Add a durable orchestrator task model owned by `plugin-agent-orchestrator`:

- `orchestrator_tasks`: id, title, goal, status, priority, owner, worldId, mainRoomId, taskRoomId, archive/delete flags, created/updated/closed timestamps, acceptance criteria, current plan, parent/fork source, provider policy, pause state.
- `orchestrator_task_sessions`: taskId, sessionId, agentType, providerSource, model, goalPrompt, workdir, status, active tool, lastActivityAt, spawnedAt, stoppedAt, completionSummary, retry count, token totals.
- `orchestrator_task_events`: taskId, sessionId, eventType, summary, data, timestamp.
- `orchestrator_task_messages`: taskId, roomId, messageId, sender kind, content refs, searchable text, timestamp. Prefer referencing existing runtime memories where possible instead of duplicating message bodies.
- `orchestrator_task_usage`: taskId, sessionId, provider, model, input/output/reasoning/cache tokens, cost estimate, source event id, timestamp.
- `orchestrator_task_artifacts`: taskId, sessionId, path/URI, artifact type, title, verification status.
- `orchestrator_task_decisions`: taskId, decision type, action selected, prompt excerpt, reasoning summary, timestamp.

The existing UI thread types in `packages/ui/src/api/client-types-cloud.ts:987` are close, but they need room/message fields, token usage, provider/model usage, pause state, and task fork lineage. The existing `CodingAgentTaskThreadDetail` already includes sessions, decisions, events, artifacts, transcripts, and pending decisions in `packages/ui/src/api/client-types-cloud.ts:1104`; extend this instead of inventing an incompatible parallel shape.

Usage capture needs backend work. ACP usage events are currently treated as informational and not surfaced in `plugins/plugin-agent-orchestrator/src/services/acp-service.ts:1639`, so token/cost UI cannot be accurate until those events are persisted and aggregated.

## Prompt And Goal Semantics

The requested behavior should be implemented as a task runner contract, not by expecting one HTTP response or one chat turn to remain open forever. The orchestrator should create a durable goal record, spawn agents with a mandatory goal wrapper, and continue dispatching, verifying, retrying, pausing, or escalating until the goal status is terminal.

Required prompt policy:

- Every `spawnSession` initial task for Claude, Codex, OpenCode, ElizaOS, and Pi Agent must pass through a single `buildGoalPrompt(...)` function.
- Every `sendToSession` follow-up from direct API, UI, or planner action must pass through `buildGoalFollowUp(...)`.
- The wrapper must include: goal, acceptance criteria, room IDs, workdir, allowed capabilities, "do not finish until complete or genuinely blocked", "verify before final", "report token/tool status when available", and "return structured completion fields".
- Direct API spawns in `agent-routes.ts` must get the same wrapper as `TASKS_SPAWN_AGENT`; currently they bypass route hints and goal semantics.
- Direct API sends in `agent-routes.ts` must get the same wrapper as `TASKS_SEND_TO_AGENT`; currently they pass raw input.
- When a sub-agent claims completion, the router should transition task state to `validating`, run verification hooks, and only mark `done` after proof passes.
- The durable task runner should keep a structured objective, blocked reason, retry/resume budget, validation state, and completion summary. Today goal persistence is prompt text plus ACP session metadata, not a true `/goal` record.

The parent orchestrator should not "return done" while a task remains active. In UI terms, this means the chat can acknowledge "task created and running", but task status remains active until validation completes. In agent terms, any final answer about the task must be gated on the durable task state, not just the sub-agent's `task_complete` event.

## API Surface Needed

Add coordinator routes under `/api/coding-agents/coordinator/*` or alias them to `/api/orchestrator/*`:

- `GET /api/orchestrator/status`: aggregate active tasks, sessions, provider usage, token spend, paused state.
- `GET /api/orchestrator/tasks?cursor=&status=&search=&includeArchived=`
- `POST /api/orchestrator/tasks`: create task from structured form or inferred chat action.
- `GET /api/orchestrator/tasks/:taskId`
- `PATCH /api/orchestrator/tasks/:taskId`: update title, goal, acceptance criteria, priority.
- `POST /api/orchestrator/tasks/:taskId/pause`
- `POST /api/orchestrator/tasks/:taskId/resume`
- `POST /api/orchestrator/tasks/:taskId/archive`
- `DELETE /api/orchestrator/tasks/:taskId`
- `POST /api/orchestrator/tasks/:taskId/fork`
- `POST /api/orchestrator/tasks/:taskId/messages`: user joins a task room.
- `GET /api/orchestrator/tasks/:taskId/messages?cursor=&limit=`
- `GET /api/orchestrator/tasks/:taskId/events?cursor=&limit=`
- `GET /api/orchestrator/tasks/:taskId/usage`
- `POST /api/orchestrator/tasks/:taskId/agents`: add sub-agent.
- `POST /api/orchestrator/tasks/:taskId/agents/:sessionId/stop`
- `POST /api/orchestrator/pause-all`
- `POST /api/orchestrator/resume-all`

Keep compatibility by mapping `client.listCodingAgentTaskThreads`, `getCodingAgentTaskThread`, `archiveCodingAgentTaskThread`, and `reopenCodingAgentTaskThread` to these real routes instead of returning stubs.

Also register and dispatch credential bridge routes if they are part of provider setup or sub-agent secret retrieval. Leaving `bridge-routes.ts` present but unmounted creates a false sense of security coverage.

Normalize the coding-agent preflight contract at the same time. Current frontend code paths expect an object with `installed`/`available` style fields, while the backend preflight route returns an array of preflight rows. This can make the code button and task affordances appear unreliably.

## Route And View Registration Recommendation

Use `/orchestrator` as the primary product route.

Preferred implementation path:

1. Rename or duplicate `plugin-task-coordinator` view registration so GUI path `/orchestrator` loads the new orchestrator component, with `/task-coordinator` retained as a compatibility alias.
2. Keep `plugin-agent-orchestrator` as the backend owner and add all durable task/coordinator routes there.
3. Keep `packages/ui` slots for shared app-shell embedding, but move the full orchestrator product UI into the plugin view bundle to avoid hardcoding a large new static page in `packages/ui`.
4. Add `orchestrator` to the UI navigation type/path map only if it needs a first-class built-in tab. If it is a plugin view with `desktopTabEnabled`, dynamic view routing can load it by path without adding a built-in tab.

This preserves the existing package boundary: Node orchestration backend in `plugin-agent-orchestrator`, React view bundle in a browser-capable plugin package, and generic shell/view infrastructure in `packages/ui`.

Do not start with cloud `/orchestrator` as the primary implementation path. Build the desktop/local route and backend task contract first, then bridge the same API shape into cloud once cloud-side agent chat/task containers expose durable task-room state.

## UX Requirements

The `/orchestrator` screen should be an operational workbench:

- Left rail: ongoing tasks with status, priority, latest activity, active sub-agent count, token spend, provider icons, pause/archive affordances, search, filters, archived toggle, and plus button.
- Center: selected room timeline with user, orchestrator, and sub-agent messages; system events collapsed by default; paginated search and jump-to-time.
- Right rail or inspector: sub-agent roster, current tool/activity, workdir/repo, active branch, artifacts, verification checklist, acceptance criteria, token/cost breakdown, provider/subscription state.
- Composer: sends to selected room, can also create/fork/update tasks via chat intent.
- Task creation: plus button opens a compact structured form, but any field can be inferred from chat.
- Controls: pause task, pause all agents, resume, archive, delete, fork, add agent, stop agent, change provider/model, copy/share task link.
- Voice/chat actions: every clickable action must have a view capability and natural-language route so "pause this task", "fork it", "show Codex only", or "add Claude to this room" works while the view is open.
- Settings: provider/subscription management must show Eliza Cloud, local Eliza, Claude, Codex/OpenAI, OpenCode, and any configured cloud routes; copy must be fully internationalized and avoid leaking tokens.

Avoid a marketing layout. This is an operator console: dense, stable, quiet, readable, and optimized for scanning.

## Secret And OAuth Flow

The codebase already has sensitive request infrastructure for secure inline owner-app secret requests and local route submission. `owner-app-inline-adapter` builds owner-only secret forms, and `sensitive-request-routes.ts` supports create/get/submit/cancel flows. Extend this for orchestrator provider setup:

- Secure cloud path: OAuth and API secrets stored in Eliza Cloud or scoped cloud vault, never pasted into public chat.
- Secure local path: local vault/secret manager when available.
- Insecure local fallback: explicit "stored locally/insecure" mode for fully local use where cloud is unavailable.
- Form inference: chat can start an OAuth/secret request, the form opens prefilled with inferred provider/scope, and user can submit in UI.
- Audit: every secret request emits redacted audit events.
- Tests: verify redaction, route auth, submission, cancellation, cloud unavailable fallback, and no accidental secret echo in messages/events/transcripts.

## Remote And Mobile Access

The requested "phone as remote to desktop agent" mode needs explicit scope:

- Local desktop runtime exposes a remote pairing/tunnel endpoint with auth and revocation.
- Mobile connects as a remote client to the desktop agent, not as a separate agent owner.
- Cloud mode connects all clients to the cloud-hosted state.
- The orchestrator task state must sync through the same API shape in both local-remote and cloud modes.
- Long-running task updates should use websocket/SSE where available, with polling fallback matching current 5-second polling.

## Test And Verification Plan

Backend unit coverage:

- Route registration includes every new `/api/orchestrator/*` and coordinator compatibility route.
- Direct HTTP handler tests for `/api/coding-agents` list/spawn/get/send/stop/output, including missing service, invalid body, spawn workdir rejection, concurrency limit, and output fallback.
- Task create/list/detail/search/pagination/archive/delete/fork/pause/resume.
- Session spawn and send always call goal-wrapper builders.
- Direct API spawn/send and planner action spawn/send produce equivalent goal envelopes.
- Sub-agent completion does not mark done until validation passes.
- Token usage aggregation handles missing provider usage, partial usage, duplicate events, and multiple providers.
- Credential bridge routes are mounted, authorized, redacted, and unavailable in modes that should not expose them.
- Store fallback works for SQL, file, and memory session stores.
- Access policy rejects unauthorized remote/mobile clients.

UI component coverage:

- Empty state, loading state, error state, active task, blocked task, validating task, done task, archived task.
- Search, pagination, task selection, task creation form, plus button, fork, pause, pause all, resume, archive, delete confirmation, add sub-agent, stop sub-agent.
- Token/cost visualizations with zero/unknown/large values.
- Provider settings and i18n keys for all visible strings.
- Voice/chat capability calls for every action.
- Preflight response normalization so provider/setup affordances render consistently.
- `mapAcpSessionsToCodingAgentSessions`, `getCodingAgentStatus`, `stopCodingAgent`, scratch workspace actions, and PTY subscribe/send/resize/buffer client helpers.

End-to-end coverage:

- Create task by plus button.
- Create task by chat message.
- Fork task from chat.
- Add Claude/Codex/OpenCode/Eliza sub-agent where available, with mocked providers in CI.
- Pause one task stops/suspends all attached agents.
- Pause all affects all running tasks.
- Archive/delete removes from active list and preserves/cleans history according to mode.
- Search and paginate main orchestrator room history and task room history.
- Secret request: secure cloud, secure local, insecure local fallback.
- Remote phone connects to desktop agent and controls an active task.
- Cloud client and desktop client see the same task state.
- Slash commands `/task`, `/tasks`, `/spawn`, and `/stop` route to the intended task APIs or planner requests with destructive-action confirmation.
- Validation failure triggers retry/reopen, not `done`.
- Token spend updates per sub-agent and aggregate.
- Terminal/output management: buffered output loads, live `pty-output` appends, interrupt sends Ctrl-C, terminal input sends a line, and stop posts to the session stop endpoint.
- Failure handling: `/api/coding-agents` 503, thread list failure, detail failure, output fetch failure, and stop failure all render actionable UI without swallowing the error silently.

Existing coverage to extend:

- `plugins/plugin-agent-orchestrator/__tests__/unit/register-routes.test.ts` verifies route loader registration.
- `plugins/plugin-agent-orchestrator/__tests__/unit/sub-agent-router.test.ts` verifies task-complete synthetic memory routing.
- `packages/app/test/ui-smoke/plugin-views-visual.spec.ts:76` already includes `/task-coordinator`.
- `packages/app/test/ui-smoke/all-pages-clicksafe.spec.ts:477` stubs coding-agent preflight/status routes.
- `packages/cloud-frontend/AGENTS.md` requires `bun run --cwd packages/cloud-frontend audit:cloud` plus manual review for any `packages/cloud-frontend` UI change.

Manual visual review:

- For `packages/ui` / plugin view changes, run local app UI smoke and plugin-view visual specs, capture desktop and mobile screenshots of `/orchestrator`, `/orchestrator?archived=1`, task detail, settings/provider setup, and secret request forms.
- Until an app-wide manual-review protocol exists, require screenshots for `/task-coordinator`, `/task-coordinator/tui`, chat with active sub-agent chip, and terminal drawer/side-panel as compatibility surfaces.
- If any `packages/cloud-frontend` files are touched, follow the mandatory cloud visual audit loop exactly and leave no affected route at `needs-work` or `broken`.
- For meaningful redesign, iterate screenshots at least five times, tracking issues fixed per loop.

## Highest Risks

- Treating ACP sessions as tasks will lose room history, fork lineage, and durable status. A real task store is required.
- Letting direct API routes bypass goal-wrapper semantics will create inconsistent worker behavior.
- Marking completion from `task_complete` alone will violate the "certain complete" requirement.
- Token accounting may not be available uniformly across Claude/Codex/OpenCode/Eliza; the UI must distinguish measured, estimated, and unavailable usage.
- Existing archive, reopen, and pause action paths report unsupported ACP-only mode, so current UI archive/reopen affordances cannot work until task-thread lifecycle exists.
- Putting the full UI in `plugin-agent-orchestrator` without a browser build will break current package boundaries.
- Building cloud UI before cloud task-room APIs exist will produce a decorative shell, not a working orchestrator.
- Preflight response mismatch can hide or misstate provider availability.
- Existing Playwright coverage proves plugin-view renderability, not the management workflows; without dedicated mocked workflow specs, regressions in stop, archive, thread detail, terminal output, and error states will slip through.
- "100% e2e coverage" is aspirational unless scoped to reachable user flows and backed by mocked provider harnesses; live Claude/Codex tests must stay gated.
- Secrets can leak through transcripts, task messages, or debug logs unless every sensitive request path redacts by default.

## Recommended Build Sequence

1. Backend task store and routes: create task/thread persistence, expose coordinator APIs, wire compatibility client methods.
2. Goal wrapper: centralize spawn/send prompt wrapping and enforce it on both action and HTTP routes.
3. Usage telemetry: capture token/cost events where providers expose them and surface estimated/unavailable states otherwise.
4. View registration: ship `/orchestrator` plugin view, keep `/task-coordinator` alias.
5. UI workbench: task rail, room timeline, sub-agent inspector, controls, create/fork flows, i18n.
6. Chat/voice capabilities: add view actions for every UI control and natural-language task commands.
7. Secret/OAuth forms: integrate sensitive-request flows into provider setup and task execution blockers.
8. Remote/mobile: unify cloud/local-remote state APIs and websocket/polling updates.
9. Tests and visual audits: build the e2e matrix, mocked providers, live gated smokes, screenshot review artifacts, and regression docs.

## Acceptance Criteria

- `/orchestrator` opens as a first-class view and `/task-coordinator` remains compatible or redirects.
- A user can create, fork, pause, resume, archive, delete, search, and inspect tasks by UI and chat/voice.
- Each task has a durable room, message history, event history, sub-agent roster, status, goal, acceptance criteria, artifacts, and usage.
- Claude/Codex/OpenCode/Eliza workers always receive goal-wrapped prompts and follow-ups.
- The orchestrator never reports a task as `done` until validation passes or a human explicitly overrides.
- Provider defaults follow configured subscription readiness: user-owned Claude/OpenAI where available, otherwise Eliza Cloud/local policy.
- Secure and local-insecure secret setup paths are clear, tested, and redacted.
- Desktop, mobile remote, and cloud clients observe consistent task state.
- Every visible string is internationalized.
- Every button/flow/input/view has automated coverage or a documented impossible-to-automate reason plus manual screenshot review.
