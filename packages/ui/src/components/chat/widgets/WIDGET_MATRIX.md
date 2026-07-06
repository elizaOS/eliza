# Chat widget matrix (#9304)

The canonical map of every widget the chat surface can render: its producing
action/marker (or data source), the surfaces it renders on, the interaction
handlers it drives, and its wired/verified status.

For home residents, the binding north-star is
`docs/design/NOTIFICATIONS-WIDGETS-SYSTEM.md` §B / §E: ambient base + pinned
notifications + at most five ranked cards. This matrix records the current code
shape, but the spec owns home-resident eligibility.

There are **two widget layers** and **two chat surfaces**. A widget belongs to
exactly one layer; the layer determines how it is produced and which surfaces
render it.

## Layers

**1. Inline reply-marker widgets.** An assistant reply embeds a text marker
(e.g. `[TASK:<id>]...[/TASK]`). `parseSegments` (`message-parser-helpers.ts`)
walks the inline registry (`inline-registry.tsx`, a process-global `Map`, no
hard-coded switch) and renders each match. A plugin teaches the chat a new
widget by calling `registerInlineWidget({ kind, parse, render })` - no edit to
`MessageContent`. Interactive widgets receive an `InlineWidgetContext` built by
the **single shared** `useInlineWidgetContext()` hook
(`use-inline-widget-context.ts`), so a CHOICE pick / FOLLOWUPS chip / FORM
submit behaves identically on both surfaces.

**2. Slot / host widgets.** Plugin widgets register a `PluginWidgetDeclaration`
(`widgets/registry.ts`) targeting a named slot. `<WidgetHost slot="...">`
(`WidgetHost.tsx`) resolves a slot -> enabled declarations -> renders them, with
home-slot live-attention ranking (`home-priority.ts`). These are surfaced by
data streams (WebSocket / store), not by reply markers.

## Surfaces

| Surface | File | Renderer | Mounted |
|---|---|---|---|
| **ContinuousChatOverlay** (primary, web/mobile) | `shell/ContinuousChatOverlay.tsx` | `InlineWidgetText` (raw `content` string) | shell root, floats over every route (`App.tsx`) |
| **ChatView** (full desktop) | `pages/ChatView.tsx` | `MessageContent` (full `ConversationMessage`) | routed view, inside the desktop layout wrapper |

Both renderers share the inline registry, so inline widgets render on both.
Both also render the non-registry segment kinds (`[CONFIG]`, permission / OAuth
/ secret cards, code blocks, GenUI ui-spec): `MessageContent` renders them
directly, and the overlay renders the same ones through `InlineWidgetText`
(plus `SensitiveRequestBlock` for the secret card, mounted by the overlay body
itself). Parity is intentional so a flow triggered on mobile is completable on
mobile - see **Documented divergences** for the few remaining ChatView-only
affordances.

---

## Inline widget matrix

| Widget | Marker | Producing action | Parser | Renderer | Handlers it calls | Surfaces | Status |
|---|---|---|---|---|---|---|---|
| **Task** | `[TASK:<threadId>]<title>[/TASK]` | `TASKS_CREATE` -> `plugin-agent-orchestrator/src/actions/tasks.ts:725` | `message-task-parser.ts` | `task-widget.tsx` `TaskWidget` | header click expands the live WS-driven pipeline (nested sub-agents + tool steps + plan) in place; `navigate` to `/orchestrator?taskId=` via the explicit "Open in workbench" link (#13536) | both (1) | wired + verified |
| **Choice** | `[CHOICE:<scope> ...]...[/CHOICE]` | model-taught (`uiWidgets` guide, #14861) AND code-emitted by actions (#14733: inbox draft/triage, approval enqueue, check-in acks, goal check-ins, RESOLVE_REQUEST disambiguation, app/plugin create) | `message-choice-parser.ts` | `ChoiceWidget.tsx` | `sendAction` | both | wired + verified |
| **Followups** | `[FOLLOWUPS ...]...[/FOLLOWUPS]` | any action emitting followup chips | `message-followups-parser.ts` | `followups.tsx` `FollowupsWidget` | `sendAction` (reply), `navigate` (navigate kind), `prefillComposer` (prompt kind) | both | wired + verified |
| **Form** | `[FORM]\n{json}\n[/FORM]` | any action emitting a form schema | `message-form-parser.ts` | `form-request.tsx` `FormRequest` | `submitForm` | both | wired + verified |
| **Workflow** | `[WORKFLOW]\n{json}\n[/WORKFLOW]` | any agent emitting an ordered step pipeline (#13536) | `message-workflow-parser.ts` | `workflow-steps.tsx` `WorkflowSteps` | none (display-only; re-emit to advance) | both | wired + verified |
| **Checklist** | `[CHECKLIST]\n{json}\n[/CHECKLIST]` | any agent emitting a standalone todo list (#13536) | `message-checklist-parser.ts` | `task-pipeline.tsx` `PlanChecklist` | none (display-only; re-emit to mutate in place) | both | wired + verified |
| **Background** | `[BACKGROUND]` (bare marker) | `BACKGROUND` op=`pick` -> `plugin-app-control/src/actions/background.ts` | `message-background-parser.ts` | `background-widget.tsx` `BackgroundWidget` (`BackgroundSettingsControls` filmstrip in `ChatWidgetShell`) | none (picks drive the persisted `useBackgroundConfig` directly, applied globally) | both | wired + verified |

(1) The Task widget is registered by `plugin-task-coordinator` (`registerTaskWidget()`), **not** auto-loaded in `inline-builtins`. It renders on both surfaces only when the orchestrator UI is loaded, by design (`MessageContent` knows nothing about tasks).

### Non-registry inline segments (rendered on both surfaces)

These are not registry widgets - they are hardcoded segment kinds. They are
**producing-action-backed** and render on **both** surfaces: `MessageContent`
renders them for ChatView, and `InlineWidgetText` renders the same segment kinds
for the overlay (importing the same renderers from `MessageContent`). The
`Overlay renderer` column names the symbol the overlay path uses.

| Segment | Marker | Producing source | ChatView renderer | Overlay renderer |
|---|---|---|---|---|
| Plugin config / connector setup | `[CONFIG:<pluginId>]` | plugin-config flows | `InlinePluginConfig` (in `ChatWidgetShell`) | `InlinePluginConfig` (`InlineWidgetText.tsx` case `config`) |
| Permission card | `__permission:...` | mobile/desktop permission requests | `MessagePermissionCard` | `MessagePermissionCard` (case `permission`) |
| Secret / OAuth request | `message.secretRequest` passthrough | credential/OAuth actions | `SensitiveRequestBlock` | `SensitiveRequestBlock` (mounted by `ContinuousChatOverlay` body) |
| Code block | fenced ``` ``` ``` ``` | any | `CodeBlock` | `CodeBlock` (case `code`) |
| GenUI ui-spec | fenced JSON / JSONL patches | Chat-Mode / Generate-Mode GenUI | `MessageUiSpecBlock` (wraps `UiRenderer`) | `MessageUiSpecBlock` (case `ui-spec`) |

### ChatWidgetShell — the standardized collapsible widget shell (#14412)

`chat-widget-shell.tsx` is the shared collapser for chat-transcript widgets:
header (icon + title + status chips + chevron), an expanded body, and a compact
collapsed summary row. Contract:

- **Start expanded while incomplete; auto-collapse to the summary once
  `complete` flips true** (connector connected, form submitted). A later
  `complete` → false transition (disconnect) auto-expands. The chevron
  re-expands/collapses at any time and a user toggle sticks until the next
  transition.
- **The collapsed body stays mounted** — hidden via `display:none` +
  `content-visibility:hidden` — so in-progress field edits survive a
  collapse/expand round-trip and the collapsed subtree costs no layout/paint.
  `contain:content` on the root isolates internal relayouts from the
  transcript. Contract lock: `chat-widget-shell.test.tsx`.

**Connector-setup widget** = the `[CONFIG:<pluginId>]` card wrapped in the
shell (the "`[CONFIG]` variant" of #14412; no separate `[CONNECTOR:]` marker).
`buildInlinePluginConfigModel` derives minimal-vs-advanced from the param
schema: when a plugin declares `required` params those are the minimal set and
every optional param moves behind `ConfigRenderer`'s Advanced disclosure (a
server `configUiHints[key].advanced: false` pins a field in the minimal set;
plugins with no required params keep the heuristic split). "Connected" =
`enabled && configured` from the plugins DTO — that drives collapse-on-connect.
Secrets keep routing through the sensitive-request flow (`SensitiveRequestBlock`,
#14326), never plain in-chat fields. Repaint lock: `InlinePluginConfig` is
memoized on its primitive `pluginId` prop so transcript re-renders bail out
before the card subtree (`MessageContent.config-render-count.test.tsx`);
behavior: `MessageContent.connector-setup.test.tsx`. Other widgets should adopt
the shell as they are touched (#14327 tracks the matrix refresh).

---

## Slot widget matrix

Notifications are NOT a slot widget: the dashboard notification center
(`components/shell/NotificationsHomeCenter.tsx`, reading the notification
store <- WS `agent_event` `stream:"notification"`) is pinned by HomeScreen
directly below the time/weather base - a registry entry would double-render
the inbox.

| Widget id | Slot | Data source / updates | Component | Host mount | Status |
|---|---|---|---|---|---|
| `agent-orchestrator.activity` | chat-sidebar | `useActivityEvents` <- WS `pty-session-event` / `proactive-message` / `agent_event` | `agent-orchestrator.tsx` `OrchestratorActivityWidget` | TasksEventsPanel | wired |
| `agent-orchestrator.apps` | chat-sidebar | poll `listAppRuns()` 5s | `agent-orchestrator.tsx` `AppRunsWidget` | TasksEventsPanel | wired |
| `agent-orchestrator.accounts` | chat-sidebar | poll `listAccounts()`/`getOrchestratorAccounts()`/`getOrchestratorRooms()` 15s | `agent-orchestrator-accounts-view.tsx` | TasksEventsPanel | wired |
| `browser.status` | chat-sidebar | browser-workspace status | `browser-status.tsx` | TasksEventsPanel | wired |
| `music-player.stream` | chat-sidebar | music-player state | `music-player.tsx` | TasksEventsPanel | wired |
| `todo.items` | home | todo store + goals store (one at-risk goal row) | `todo.tsx` | ViewCatalog | wired |
| `calendar.upcoming` | home | calendar store | `calendar-upcoming.tsx` | ViewCatalog | wired |
| `music-library.playlists` | character | music-library state | n/a | CharacterHubView | wired |

Demoted / merged per `docs/design/NOTIFICATIONS-WIDGETS-SYSTEM.md` §E items
3-5: `wallet.balance` and `health.sleep` no longer declare `slot:"home"`
(their routed surfaces stay), and `goals.attention` no longer stands alone on
home because its at-risk row is rendered inside `todo.items`.

### Slots & host mounts

| Slot | Host mounted? | Widgets registered? | Verdict |
|---|---|---|---|
| `home` | yes, HomeScreen | yes, curated ≤5 residents (tutorial launcher removed) | active |
| `chat-sidebar` | yes, TasksEventsPanel | yes, 5 | active |
| `character` | yes, CharacterHubView | yes, 1 | active |
| `nav-page` | no WidgetHost mount | no component widgets | active app-navigation contract |


Retired slots pruned in #9448: `chat-inline`, `wallet`, `browser`,
`heartbeats`, `settings`, `automations`. Browser status now renders through the
active `chat-sidebar` declaration. Wallet remains a routed surface; its home
resident was demoted by the home surface spec because balance state is not
resting urgency.

---

## Interaction handler contract (single source of truth)

All four handlers are produced by `useInlineWidgetContext(sendActionMessage,
setChatInput)` (`use-inline-widget-context.ts`) and consumed identically by both
surfaces:

| Handler | Effect |
|---|---|
| `sendAction(value)` | `sendActionMessage(value)` - value re-enters the message pipeline |
| `navigate(payload)` | dispatch `eliza:navigate:view`; `/`-prefixed -> `{viewPath}`, else `{viewId}` |
| `prefillComposer(payload)` | `setChatInput(payload)` (inert no-op outside a chat provider) |
| `submitForm(id, values)` | `sendActionMessage("[form:submit <id>] <json>")` |

A widget that calls a handler the surface doesn't provide would be a broken
pipeline; because both surfaces build the context from this one hook, that class
of bug is structurally impossible.

---

## Information-density model (UX intent, #9304)

Every stateful widget lives at one of three densities; the user moves between
them by intent, never by hunting a chrome button:

1. **Glance** - chat/home card: status as color + icon, least text, no actions.
2. **Expand-in-place** - tap the card header -> grows inline (nested sub-agents,
   live tool steps, plan checklist), stream-driven, without leaving chat.
   Implemented for Task in #13536.
3. **Full view page** - deep review + the few real controls. Tasks have this at
   `/orchestrator?taskId=` (the workbench), reached via the card's explicit
   "Open in workbench" link.

`TaskWidget` is the reference glance+expand design (a compact card that expands
its live WS-driven pipeline in place; the single "Open in workbench" link is the
only navigation affordance).

---

## Documented divergences (intentional, not gaps)

- **D1 - segment parity (resolved, no longer a divergence).** `[CONFIG]`,
  permission, secret/OAuth, code blocks, and GenUI ui-spec now render on **both**
  surfaces: the overlay's `InlineWidgetText` handles `config` / `ui-spec` /
  `permission` / `code` and `ContinuousChatOverlay` mounts `SensitiveRequestBlock`
  for `message.secretRequest`. The old "ChatView-only, mobile flow uncompletable"
  gap is closed and pinned by tests - see the D1-parity rows under Coverage. Kept
  here only as a pointer; there is no remaining segment-kind divergence.
- **D2 - per-message rail.** ChatView owns edit/delete/speak/retry/suggest;
  the overlay exposes press-and-hold copy only (mobile-first). Intentional.
- **D3 - topic chips / grouped transcript.** Overlay-only. Intentional.
- **D4 - chat-sidebar host.** Neither surface mounts it; it lives in the
  desktop layout wrapper (`TasksEventsPanel`). The overlay has no side rail by
  design (pull-up sheet).

---

## Coverage status

| Widget | Unit/behavior | Story | E2E |
|---|---|---|---|
| Task | yes | yes (added #9304) | yes, `task-widget-in-chat` |
| Choice | yes | yes | n/a |
| Followups | yes | yes | n/a |
| Form | yes | yes | n/a |
| Notification center (pinned `NotificationsHomeCenter`) | yes | yes | yes, home-screen e2e |
| Messages | yes | yes (added #9304) | n/a |
| Orchestrator activity | yes (e2e fixture) | yes | n/a |
| Orchestrator accounts | yes (e2e fixture) | yes | n/a |
| Grilling card | yes (added #9304) | yes | n/a |
| Credential request | yes (added #9304) | yes | yes, `sensitive-request-in-chat` |
| Browser status | yes (added #9304) | n/a | n/a |
| Music player | yes (added #9304) | n/a | n/a |
| Topic chips bar | yes (added #9304) | yes | n/a |
| Topic grouped transcript | yes (added #9304) | yes | n/a |
| Home widgets (todo/calendar/needs-attention/setup progress; removed residents stay absent) | yes + coverage gate | n/a | n/a |
| Overlay `[CONFIG]` / code / UiSpec parity (D1) | yes, `InlineWidgetText.test.tsx` (`[CONFIG:…]`, code fence, UiSpec cases) | n/a | n/a |
| Overlay secret-request parity (D1) | yes, `render-parity.contract.test.tsx` (asserts `[data-testid="sensitive-request"]` renders in the overlay body) | n/a | n/a |

`widgets/widget-coverage.test.ts` gates that the home-slot and the inline
registry never silently lose a widget (extended in #9304): dropping a gated
widget fails CI.

---

_Last verified against code: this matrix was re-checked row-by-row against the
current renderers for #14327. The load-bearing correction (D1: the overlay
renders `[CONFIG]` / permission / secret / code / GenUI, not ChatView-only) is
proven by `InlineWidgetText.tsx` (cases `config` / `ui-spec` / `permission` /
`code`) + `ContinuousChatOverlay.tsx` (`SensitiveRequestBlock` on
`message.secretRequest`), and pinned by `InlineWidgetText.test.tsx` +
`render-parity.contract.test.tsx`._
