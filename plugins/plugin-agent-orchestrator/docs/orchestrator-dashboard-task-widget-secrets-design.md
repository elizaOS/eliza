# Orchestrator dashboard, in-chat task widget, and secrets widgets — design

Date: 2026-06-05. Companion to
[`orchestrator-buildout-followups.md`](./orchestrator-buildout-followups.md).

This is a code-grounded, intentionally small design for three connected gaps the
goal hook calls out, in priority order:

1. **Orchestrator view should read as a *dashboard*** of ongoing tasks — quick
   active/finished/needs-attention counts at the top, a minimal card list
   underneath, click a card to drill into the existing full inspector.
2. **Task creation should drop a live `TaskWidget` into the chat** that shows
   status and is clickable. The chat conversation continues; the agent keeps
   task context; the orchestrator view's action bar stays view-dependent on the
   currently-selected task.
3. **Sensitive-request widgets in chat (form / OAuth / secret) must
   actually work and be tested**, with no secret material echoed to chat.

Scope is intentionally narrow. The existing
[`OrchestratorWorkbench.tsx`](../src/OrchestratorWorkbench.tsx) (4142 LOC) is
mature — rail, inspector, action bar, timeline, operator drawer, plan editor.
We do not redesign it. We add a thin glance strip, fix the gaps, and lock
behavior in tests.

## What exists today (ground truth)

- `OrchestratorWorkbench` renders `/orchestrator`. Header has Pause All / Resume
  All / New Task; a filter dropdown shows status + count; rail renders
  `TaskCardList` cards. Selecting a card swaps the rail for a full-pane task
  room with timeline + inspector (`data-testid="orchestrator-inspector"`).
  Inspector action bar is already view-dependent: validating → Approve/Reject,
  archived → Reopen, active → Pause/Resume, plus Fork/Restart/Add Agent.
- `MessageContent.tsx` dispatches 7 segment kinds: `text`, `config`, `ui-spec`,
  `choice`, `followups`, `form`, `permission`, `analysis-xml`. **There is no
  `task-widget` kind**. A `[TASK:id]title[/TASK]` block in an assistant message
  renders as plain text today.
- `SensitiveRequestBlock` (in `MessageContent.tsx`) renders inline-secret form
  widgets driven by `message.secretRequest`. It is tested
  (`MessageContent.sensitive-request.test.tsx`). It supports `form.kind ===
  "secret"` only; **OAuth is not wired** — `owner-app-inline-adapter.ts`
  explicitly rejects any non-secret kind.
- `task-coordinator-gui-interactions.spec.ts` covers list, search, open detail,
  archive, reopen. `orchestrator-gui-workbench.spec.ts` covers the rich rail
  and inspector controls (priority change, restart-with-plan, add agent,
  pause/resume, retry/rerun). **Neither covers a chat task widget or any
  sensitive-request widget.**

## Design

### 1. `OrchestratorGlanceStrip` — at-a-glance dashboard tile

A single pinned row above the rail, four count tiles + the existing usage chip.
No new state — derived from the same `/api/orchestrator/status` payload the
header reads. Each tile is a button that sets the filter and scrolls the rail
to the top.

```
┌─────────────────────────────────────────────────────────────────┐
│ ● 3 Active   ◐ 1 Validating   ⚠ 0 Blocked   ✓ 12 Done   12.3K · $0.42 │
└─────────────────────────────────────────────────────────────────┘
```

Rules:

- **One row, fixed height.** ~32px. No subtitle text under counts.
- **Color = state, not decoration.** `ok` for Active, `accent` for Validating,
  `warn` for Blocked, `muted` for Done.
- **Zero = `muted` text + de-emphasized tile.** Zero counts never animate.
- **Click filters.** Click "Active" → filter "active". Click "Blocked" →
  filter "blocked" (rolls up `waiting_on_user` per existing status fan-out).
- **Hidden when there are zero tasks total** — the empty state already covers
  this case.

Test ids: `orchestrator-glance`, `orchestrator-glance-active`,
`orchestrator-glance-validating`, `orchestrator-glance-blocked`,
`orchestrator-glance-done`.

Implementation: new component `OrchestratorGlanceStrip.tsx` rendered in
`OrchestratorWorkbench.tsx` directly above the rail. It reads
`taskCount`/`activeTaskCount`/`blockedTaskCount`/`validatingTaskCount` from
the same status payload `WorkbenchHeader` already consumes; we promote a small
counts derivation out so both call sites stay in sync.

### 2. `TaskWidget` — inline chat widget for an orchestrator task

A new segment kind in `MessageContent`. The agent emits
`[TASK:<threadId>]<title>[/TASK]` after a successful `TASKS_CREATE`, and the
chat renderer replaces it with a live widget.

Anatomy (one compact card, ~64px tall):

```
┌────────────────────────────────────────────────────────┐
│ ▶ Build Kanban planner app           [Open]           │
│   ● active · 2/2 agents · 3m ago · ~12.3K              │
└────────────────────────────────────────────────────────┘
```

Rules:

- **One title line + one status line.** No goal, no acceptance criteria, no
  artifact list. Those live in the orchestrator inspector.
- **Status line is structured, not prose.** Status dot + label, agents
  active/total, relative last activity, token total. Tokens hidden when
  `usageState === "unavailable"`.
- **Click → navigate `/orchestrator?taskId=<id>`** (the workbench already
  reads `?task=` via `readInitialTaskId`; we alias `?taskId=` to it).
- **Live updates by polling**, not WebSocket. Reuses the workbench's
  `POLL_INTERVAL_MS = 5000` (kept in one place — exported, not duplicated). On
  unmount, polling stops. When the underlying task is terminal
  (`done`/`failed`/`archived`/`closed`), polling stops and the status freezes.
- **One outstanding fetch per widget.** Concurrent renders share a tiny
  per-thread cache so two widgets in scrollback don't quadruple traffic.
- **No action buttons inline.** Action belongs to the workbench's
  view-dependent action bar (we are explicit about this — the goal asks the
  workbench to own actions when on a task).
- **Failure mode is silent.** If the task 404s (deleted), the widget shrinks
  to "Task removed." in muted text; it never throws into the chat.

Backend hook: after `TASKS_CREATE` succeeds, the action's response text gets
`[TASK:${task.id}]${task.title}[/TASK]` appended. This is a one-line change in
`tasks.ts` (the `create` runner already returns a callback with prose).

Segment parser: extend the existing regex sweep in
`MessageContent.parseSegments` with a `[TASK:...]...[/TASK]` pattern, ordered
after `[FORM]` and before plain text. The matcher requires `threadId` to be a
UUID-shaped string (lowercase a–f0-9-) to avoid trivial injection from
unrelated text.

Test ids: `task-widget`, `task-widget-status`, `task-widget-open`.

### 3. View-dependent action bar in the workbench

Already exists in `TaskInspector` (`OrchestratorWorkbench.tsx` lines
2007–2187). It is correctly state-conditional but every button is always
rendered (just disabled when N/A). The minimal change is grouping and hiding:

- **Hide the entire "Edit" group** (Fork, Restart, Add Agent, Edit Plan) when
  `task.status` is in {`done`, `failed`, `archived`, `closed`}. Terminal tasks
  should only expose Reopen (and Delete).
- **Hide priority dropdown for terminal tasks.** Priority is meaningless once
  closed.
- **Keep validating-task Approve/Reject as the only primary affordance.**
  Other buttons collapse into an overflow.

This is small — three `if` guards. Locked in by an inspector test that
toggles status and asserts visibility.

### 4. Sensitive-request widgets — what's working and what we add

Working today: inline form for `kind: "secret"`. We tighten and extend.

**a. `SensitiveRequestBlock` polish (existing component, small fix)**

- Distinguish `pending` (gray "Pending"), `saving` (spinner + "Saving…"),
  `saved` (green "Saved" + redacted preview "•••• (saved)"),
  `failed` (red "Failed — retry"), `expired` (muted "Expired").
- On `saved`, the form **never re-renders the password input** for the same
  request id, even if the message re-mounts. Backed by a tiny per-requestId
  saved-state cache in component scope.
- Reason and instruction text already render; we make sure they never include
  the secret value (server-side sanitization is the actual guarantee; the
  widget asserts `value` is never substituted into `instruction` or `reason`
  via `MessageContent.sensitive-request.test.tsx`).

**b. `OAuthRequestBlock` (new, in `MessageContent.tsx`)**

Renders when `message.secretRequest.form.kind === "oauth"`. Shape:

```
┌────────────────────────────────────────────┐
│  Connect GitHub                            │
│  Needed for: managing PRs on this task     │
│                                            │
│  [ Connect with GitHub → ]   Pending       │
└────────────────────────────────────────────┘
```

Rules:

- **One button.** It calls `client.startSensitiveRequestOAuth(requestId)`
  which returns `{ authorizationUrl, state }` and opens it in a popup
  (`window.open` with a sized rect). Same-origin fallback for embedded
  environments where popups are blocked.
- **No token ever passed through chat.** The OAuth callback fulfills the
  request server-side; the widget polls
  `GET /api/sensitive-requests/:id/status` every 2s, up to `expiresAt`, and
  stops on terminal states.
- **Visible state machine:** `Pending` → `Authorizing…` → `Saved` |
  `Failed — retry` | `Expired`.
- **Cancel.** A small `Cancel` link sends `DELETE
  /api/sensitive-requests/:id` and flips to `Cancelled`.

Backend wiring is a sibling of the inline adapter:
`packages/app-core/src/services/sensitive-requests/owner-app-oauth-adapter.ts`.
The adapter's `deliver()` accepts `request.target.kind === "oauth"` requests
(new target kind), builds an envelope with `form: { kind: "oauth", provider,
scopes, label, submitLabel: "Connect …" }`, and sends the inline chat content.
The OAuth callback handler lands tokens in `sharedVault` exactly like the
existing GitHub OAuth flow; only the *trigger* differs.

We do **not** ship a generic OAuth backend in this slice. We ship the widget +
its parser + a fixture-backed e2e + a unit test for envelope construction.
A follow-up wires production providers (per
[`orchestrator-buildout-followups.md`](./orchestrator-buildout-followups.md)
section B).

**c. `FormRequest` (existing `[FORM]` widget) — unchanged**

The non-sensitive `[FORM]` widget already works
(`form-request.tsx`). It is referenced here only to draw the line: that
widget's submission **is echoed to chat** because it carries non-secret data.
Sensitive requests must never reuse it.

### Security guarantees we explicitly maintain

- The secret/OAuth widgets must never push the value or token into the chat
  message stream. The current inline adapter calls
  `client.updateSecrets(secrets)` directly and ignores its message channel
  for the value; we keep that, and add an integration test that scrapes the
  recorded chat-message stream after a successful save and asserts no field
  value appears.
- OAuth callbacks must never include tokens in URL fragments delivered to the
  chat surface. The popup posts the result to the server; the chat surface
  only sees `status` transitions.
- Widget rendering is gated on `delivery.canCollectValueInCurrentChannel ===
  true`. Public/group surfaces continue to render the existing
  status-only card pointing at the owner app.

## Tests

All under existing infra (`packages/ui` vitest for components,
`packages/app/test/ui-smoke` Playwright for the route).

1. **Component (vitest, packages/ui):**
   - `MessageContent.task-widget.test.tsx` — `[TASK:id]title[/TASK]` parses to a
     `TaskWidget`; renders title; polls once and renders status; click
     dispatches navigation.
   - `MessageContent.sensitive-request.test.tsx` (extend) — status transitions;
     saved-state cache survives remount; instruction never contains the
     entered value.
   - `MessageContent.oauth-request.test.tsx` — OAuth widget shows Connect,
     opens popup (mocked `window.open`), polls status, lands on `Saved`.

2. **Plugin (vitest, plugin-agent-orchestrator):**
   - `create-task-emits-task-block.test.ts` — `TASKS_CREATE` runner output
     contains `[TASK:${id}]${title}[/TASK]`.
   - `owner-app-oauth-adapter.test.ts` — envelope shape; rejects non-OAuth
     kind; emits an inline content with `form.kind === "oauth"`.

3. **Playwright (packages/app):**
   - Extend `orchestrator-gui-workbench.spec.ts` with a `glance strip` test —
     fixture seeds 3 active / 1 validating / 12 done; assert tile counts;
     click Validating → filter switches; assert rail shows only the validating
     task.
   - New `task-widget-in-chat.spec.ts` — boot the chat route, send a
     "create task X" prompt, mock the orchestrator POST to return a fixture
     task, assert a `task-widget` appears, status flips to active when the
     mocked poll returns active, click `task-widget-open` lands on
     `/orchestrator?taskId=…` with that task selected and its inspector
     visible.
   - New `sensitive-request-in-chat.spec.ts` —
     (a) seed a secret request, fill the password, submit, assert
     `client.updateSecrets` was called with that field, assert the password
     is **never** posted to any chat-message endpoint;
     (b) seed an OAuth request, click Connect, mock popup `postMessage`
     completion, assert status flips to Saved without any token appearing in
     the chat-message stream.

4. **Scenario runner (`packages/scenario-runner`):** add a `task-creation`
   scenario that drives the e2e create → widget → click → workbench path
   against the real orchestrator routes, using the fake-ACP transport already
   used by the orchestrator unit tests. Gated under `test:e2e:manual` because
   it needs the ACP transport pinned, matching the existing convention.

## Out of scope (explicitly)

- Replacing the 5s poll with SSE/WS — that's
  [`orchestrator-buildout-followups.md`](./orchestrator-buildout-followups.md)
  section D and design-touching.
- A general "remote/mobile orchestrator" — same followups section D.
- Re-anchoring planner follow-ups to durable goal — section F.
- Real production OAuth providers beyond the widget — see followups B.

## Rollout

One PR per slice keeps blast radius small and lets the visual review run on
each:

1. Slice 1: `OrchestratorGlanceStrip` + counts derivation + tests.
2. Slice 2: `task-widget` segment + `TaskWidget` component +
   `TASKS_CREATE` emission + unit tests.
3. Slice 3: `task-widget-in-chat.spec.ts`.
4. Slice 4: Sensitive-request polish + OAuth widget + adapter +
   `sensitive-request-in-chat.spec.ts`.
5. Slice 5: View-dependent inspector cleanup (hide Edit group on terminal,
   hide priority on terminal) + inspector test.

Each slice ships and gets an audit pass. No slice is "done" until the
relevant Playwright spec is green locally and the chat / `/orchestrator`
route renders cleanly under the workbench audit pass.
