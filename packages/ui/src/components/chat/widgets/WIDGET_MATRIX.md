# Chat widget matrix (#9304)

The canonical map of every widget the chat surface can render: its producing
action/marker (or data source), the surfaces it renders on, the interaction
handlers it drives, and its wired/verified status.

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
`MessageContent` additionally renders host-only segment kinds (`[CONFIG]`,
permission / OAuth / secret cards, code blocks, GenUI ui-spec) that the overlay
does not - see **Documented divergences**.

---

## Inline widget matrix

| Widget | Marker | Producing action | Parser | Renderer | Handlers it calls | Surfaces | Status |
|---|---|---|---|---|---|---|---|
| **Task** | `[TASK:<threadId>]<title>[/TASK]` | `TASKS_CREATE` -> `plugin-agent-orchestrator/src/actions/tasks.ts:725` | `message-task-parser.ts` | `task-widget.tsx` `TaskWidget` | none (display-only; whole-card navigate to `/orchestrator?taskId=`) | both (1) | wired + verified |
| **Choice** | `[CHOICE:<scope> ...]...[/CHOICE]` | any action emitting a choice block | `message-choice-parser.ts` | `ChoiceWidget.tsx` | `sendAction` | both | wired + verified |
| **Followups** | `[FOLLOWUPS ...]...[/FOLLOWUPS]` | any action emitting followup chips | `message-followups-parser.ts` | `followups.tsx` `FollowupsWidget` | `sendAction` (reply), `navigate` (navigate kind), `prefillComposer` (prompt kind) | both | wired + verified |
| **Form** | `[FORM]\n{json}\n[/FORM]` | any action emitting a form schema | `message-form-parser.ts` | `form-request.tsx` `FormRequest` | `submitForm` | both | wired + verified |

(1) The Task widget is registered by `plugin-task-coordinator` (`registerTaskWidget()`), **not** auto-loaded in `inline-builtins`. It renders on both surfaces only when the orchestrator UI is loaded, by design (`MessageContent` knows nothing about tasks).

### Host-only inline segments (rendered by `MessageContent`, not the overlay)

These are not registry widgets - they are hardcoded segment kinds in
`MessageContent.tsx`. They are **producing-action-backed** but render only on
ChatView today (see divergence D1).

| Segment | Marker | Producing source | Renderer |
|---|---|---|---|
| Plugin config | `[CONFIG:<pluginId>]` | plugin-config flows | `InlinePluginConfig` |
| Permission card | `__permission:...` | mobile/desktop permission requests | `PermissionCard` |
| Secret / OAuth request | sensitive-request markers | credential/OAuth actions | sensitive-request renderers |
| Code block | fenced ``` ``` ``` ``` | any | `CodeBlock` |
| GenUI ui-spec | fenced JSON / JSONL patches | Chat-Mode / Generate-Mode GenUI | `UiRenderer` |

---

## Slot widget matrix

Notifications are NOT a slot widget: the dashboard notification center
(`components/shell/NotificationsHomeCenter.tsx`, reading the notification
store <- WS `agent_event` `stream:"notification"`) is pinned by HomeScreen
directly below the time/weather base — a registry entry would double-render
the inbox.

| Widget id | Slot | Data source / updates | Component | Host mount | Status |
|---|---|---|---|---|---|
| `agent-orchestrator.activity` | chat-sidebar + home | `useActivityEvents` <- WS `pty-session-event` / `proactive-message` / `agent_event` | `agent-orchestrator.tsx` `OrchestratorActivityWidget` | TasksEventsPanel + ViewCatalog | wired |
| `agent-orchestrator.apps` | chat-sidebar + home | poll `listAppRuns()` 5s | `agent-orchestrator.tsx` `AppRunsWidget` | TasksEventsPanel + ViewCatalog | wired |
| `agent-orchestrator.accounts` | chat-sidebar | poll `listAccounts()`/`getOrchestratorAccounts()`/`getOrchestratorRooms()` 15s | `agent-orchestrator-accounts-view.tsx` | TasksEventsPanel | wired |
| `browser.status` | chat-sidebar | browser-workspace status | `browser-status.tsx` | TasksEventsPanel | wired |
| `music-player.stream` | chat-sidebar | music-player state | `music-player.tsx` | TasksEventsPanel | wired |
| `todo.items` | home | todo store | `todo.tsx` | ViewCatalog | wired |
| `inbox.unread` | home | inbox store | `inbox-unread.tsx` | ViewCatalog | wired |
| `relationships.attention` | home | relationships store | `relationships-attention.tsx` | ViewCatalog | wired |
| `calendar.upcoming` | home | calendar store | `calendar-upcoming.tsx` | ViewCatalog | wired |
| `goals.attention` | home | goals store | `goals-attention.tsx` | ViewCatalog | wired |
| `finances.alerts` | home | finances store | `finances-alerts.tsx` | ViewCatalog | wired |
| `health.sleep` | home | health store | `health-sleep.tsx` | ViewCatalog | wired |
| `music-library.playlists` | character | music-library state | n/a | CharacterHubView | wired |

### Slots & host mounts

| Slot | Host mounted? | Widgets registered? | Verdict |
|---|---|---|---|
| `home` | yes, HomeScreen | yes, many | active |
| `chat-sidebar` | yes, TasksEventsPanel | yes, 5 | active |
| `character` | yes, CharacterHubView | yes, 1 | active |
| `nav-page` | no WidgetHost mount | no component widgets | active app-navigation contract |


Retired slots pruned in #9448: `chat-inline`, `wallet`, `browser`,
`heartbeats`, `settings`, `automations`. Browser and wallet status now render
through active `chat-sidebar` / `home` declarations instead of their own dead
slots.

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
2. **Expand-in-place** *(proposed)* - tap the card -> grows inline (sub-steps,
   last activity) without leaving chat. The card is the control.
3. **Full view page** - deep review + the few real controls. Tasks have this at
   `/orchestrator?taskId=` (the workbench); buttons live here so glance/expand
   stay button-free.

`TaskWidget` is the reference glance design (one ~64px card, whole-card
navigate, zero action buttons, self-polling, freezes on terminal). Tier 2 is
the open proposal.

---

## Documented divergences (intentional, not gaps)

- **D1 - host-only segments.** `[CONFIG]`, permission/secret/OAuth cards, code
  blocks, and GenUI render on ChatView (`MessageContent`) only; the overlay
  (`InlineWidgetText`) renders prose + the four registry widgets. *Intended end
  state:* the overlay should at minimum render the secret/OAuth card so a flow
  triggered on mobile is completable on mobile. Tracked as follow-up.
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
| Home widgets (inbox/calendar/goals/finances/health/relationships) | yes + coverage gate | n/a | n/a |

`widgets/widget-coverage.test.ts` gates that the home-slot and the inline
registry never silently lose a widget (extended in #9304): dropping a gated
widget fails CI.
