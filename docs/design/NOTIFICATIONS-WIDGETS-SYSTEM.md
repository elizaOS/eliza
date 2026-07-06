# Notifications + Widgets System

North-star spec for the home surface, the notification pipeline, and in-chat
widgets. This is the document other lanes implement against. It is grounded in
what exists on `develop` today (post #14485 de-clutter, post #14349 breadth-mandate
retirement) and in the architectural direction set by the board-15 chat-widgets
sweep (#14412 synthesis) and the uiWidgets/uiGenerative provider split (#14524).

**Product frame:** elizaOS is an operating system for an agent that also ships
as an app. The agent does things autonomously; **home is where its activity
becomes glanceable**, notifications are where it becomes **interruptive**, and
chat is where it becomes **conversational**. The primary device is an iPhone
running the iOS PWA. Every budget in this document assumes a mid-range phone on
a cell connection.

---

## A. Principles

1. **The two-second rule.** Every home widget answers *"what changed while I
   was gone?"* in under two seconds of looking. If a card requires reading a
   paragraph, tapping to understand, or mental arithmetic, it is not a home
   widget. (Prior art: iOS lock-screen widgets and watchOS complications are
   legible at arm's length; that is the grammar.)

2. **No widget without a live data source.** A home widget must be backed by a
   data source that exists in the runtime *today* or is one endpoint away. No
   speculative cards, no "coming soon" placeholders, no widgets that render
   sample data. (This is why #14485 removed finances/relationships/inbox
   residents — the domains exist, but their *glanceable urgency* signal did
   not.)

3. **One job per surface.**
   - **Notification = interrupt.** It exists to break attention, exactly once,
     and then live in the inbox as a record.
   - **Home widget = glance.** It exists to be read passively, at rest, with
     zero interaction.
   - **Chat widget = artifact.** It exists *inside a conversation turn* as the
     structured form of something the agent said or needs.
   A piece of information belongs to exactly one of these by default. The same
   fact appearing as an interrupt, a resident card, *and* a chat bubble is the
   noise pattern #14485 cut.

4. **Hard cap on the home.** The home renders: the ambient base (clock +
   weather), the pinned notification center, and **at most five** ranked
   cards. Not twelve (`HOME_RENDER_CAP` is currently 12 — see §E). A phone
   viewport shows the wallpaper, the base, the notification stack, one or two
   cards, and the chat bar. That is the whole product surface, and that is
   deliberate.

5. **Empty means invisible.** A widget with nothing worth saying renders
   `null`. Never an empty-state card on home (`WidgetProps.slot === "home"`
   contract, #9143). A quiet agent produces a quiet home: wallpaper, clock,
   weather, chat bar. That resting state is a feature, not a bug.

6. **Event-driven or visibility-gated; never polling re-renders.** Home is
   always-mounted. Anything that re-renders it on a timer, polls an endpoint
   on an interval while hidden, or blurs a compositing layer per frame pays
   its cost forever. Data arrives by WS push or store subscription; clocks
   tick in leaf components; tickers pause when the document is hidden.

7. **Every widget earns its slot or dies.** A resident card must demonstrate a
   recurring attention signal (`home-attention` publishes, or ranked signal
   kinds actually firing). A card that has self-hidden for every user for a
   release cycle is a kill candidate. Curation is ongoing, not a one-time
   sweep — frontpage presence is opt-in and curated, never mandated (#14349).

8. **Chat carries artifacts, not apps.** The iMessage app-drawer is the
   canonical failure mode: a tray of mini-apps nobody opens, competing with
   the conversation. We never build a widget drawer, a widget picker, or
   persistent chat chrome. Widgets appear *because the agent emitted one in a
   turn*, scroll with the transcript like any other utterance, and collapse
   when their job is done.

---

## B. Home surface spec

### Anatomy (top to bottom)

```
┌──────────────────────────────┐
│  wallpaper (full-bleed)      │
│                              │
│  clock + weather   (ambient) │  Tier 1 — never ranked, never hidden*
│  notifications     (pinned)  │  self-hides when empty
│  ┌────────────────────────┐  │
│  │ ranked cards (≤ 5)     │  │  Tier 2/3/4, priority-ranked,
│  │ …                      │  │  each self-hiding
│  └────────────────────────┘  │
│                              │
│  chat bar (composer)         │  the one persistent control
└──────────────────────────────┘
```

\* clock is user-hideable (#10706); weather is independent.

### The ideal ranked set

Five residents maximum. Each entry below states data source (exists today),
glance content, tap behavior, empty state, refresh model, and perf budget.

#### 1. Needs Response — `needs-attention.pending`

The single most important card on home: the agent is *blocked on the user*.

- **Data source:** core `ApprovalService` (#9449) via store; WS-pushed. Exists.
- **Glance:** count + the top pending item's one-line question. "2 waiting —
  Approve sending the email to JJ?"
- **Tap:** opens the approval in chat (deep-link to the thread turn), not a
  separate approvals app.
- **Empty:** `null`. No "all clear" card.
- **Refresh:** WS event → store → render. Zero polling.
- **Perf:** re-renders only on approval-set change. No timers.
- **Rank:** `approval`/`escalation`/`blocked` signals (weights 9–10) — always
  wins the top slot when live. Correct as-is.

#### 2. Up Next — `calendar.upcoming`

- **Data source:** calendar store (core API-backed). Exists.
- **Glance:** the next event only: title, time-until ("in 40 min"), location
  line if present. One event, not an agenda. Full-width row (`cols: 4` — keep).
- **Tap:** opens the calendar day view (routed), or the event's deep link.
- **Empty:** `null` when no event inside the lookahead window (next 18h).
  An event next Tuesday is not glanceable urgency.
- **Refresh:** store push; the "in 40 min" countdown uses a leaf
  `<RelativeTime>` (§C.4) so the card body never re-renders on the minute tick.
- **Perf:** one leaf text node updates per minute, visibility-gated.
- **Rank:** self-publishes `home-attention` as the event approaches
  (weight ramps inside T-2h). Exists via `home-attention-store.ts`.

#### 3. Today — `todo.items` (absorbing goals-attention)

- **Data source:** todo/workbench store (`visibility: "fallback"`). Exists.
- **Glance:** up to 3 items due/overdue today, checkbox affordance, overdue in
  the accent color. If the goals plugin reports an at-risk goal, it renders as
  one flagged row *inside this card* rather than as a second resident card
  (merge verdict, §E).
- **Tap on row:** toggles done (optimistic). **Tap on header:** opens todos.
- **Empty:** `null` when nothing due today and nothing overdue. A long-range
  backlog is not a glance.
- **Refresh:** store subscription. No timers.
- **Rank:** `reminder`/`check-in`/`nudge` signals + self-published attention
  when overdue count > 0.

#### 4. Setup progress — `model-download.status` / `agent-provisioning.status`

Transient by nature: they exist only during first-run/provisioning windows.

- **Data source:** local-inference hub events (LOCAL) / cloud handoff phase
  event (CLOUD). Exists.
- **Glance:** progress bar + phase label. The one thing between a fresh agent
  and its first reply, so full-width prominence while live is correct.
- **Tap:** none required (status only); provisioning card may expose a retry.
- **Empty:** self-hides permanently once complete.
- **Refresh:** event stream. No polling.
- **Rank:** setup signals; they own the top while active, vanish after.

#### 5. Welcome — `ftu-welcome` (Tier 4, sunset)

- **Data source:** none needed (core FTU surface).
- **Glance:** greeting + 2–3 prompt chips that teach the chat bar.
- **Tap:** chip prefills/sends into the composer.
- **Empty/lifecycle:** the **only** card class using the sunset lifecycle —
  retires permanently `afterAction`/`dismissible`/`afterSeen` via
  `home-dismissal-store`. Correct as-is.
- **Rank:** `welcome` weight 8 — above cold cards, below any real "act now"
  signal. Correct as-is.

### Explicitly NOT residents (and why)

- **`wallet.balance`** — a balance is state, not *change*. It fails the
  two-second rule's real question ("what changed?"). Demote to launcher/routed
  view; a large delta becomes a **notification** (category `general`/`system`,
  producer-side), which is the correct surface for "something changed with
  your money." (§E, migration item.)
- **`health.sleep`** — same failure: yesterday's sleep score is a daily digest
  fact, not resting urgency. The *alert* case (threshold crossed) is already a
  notification category (`health`). Demote the resident card; keep the routed
  view. (§E.)
- **Activity/app-run/workflow streams, inbox, finances, relationships** —
  removed in #14485; this spec ratifies the removal. Continuous streams belong
  in the chat sidebar and routed views. Their *urgent moments* travel as
  notifications.

### Home perf budget (binding)

- **No `useNow` above a leaf.** Timers live in `<RelativeTime>`-class leaf
  components only (§C.4).
- **All tickers visibility-gated:** paused when `document.hidden` (the PWA is
  backgrounded far more than foregrounded).
- **No interval polling from any home widget.** WS/store push only. (The 5s
  `listAppRuns` poll pattern is confined to the chat sidebar and should not be
  ported home.)
- **Compositing:** at most one `backdrop-filter` surface on home (the
  notification glass), and it must sit on a non-scrolling element. Prefer
  `bg-card/70` translucency without blur on low-end devices; treat blur as a
  progressive enhancement, never a requirement for legibility.
- **Render-storm locks stay:** `WidgetHost.render-storm.test.tsx` protects the
  host; new residents must add equivalent locks.

---

## C. Notifications spec

### C.1 Triage model: interrupt / digest / silent

The runtime already has the right primitive — `NotificationPriority` on
`AgentNotification` (`packages/core/src/types/notification.ts`) — and the store
already routes on it. This spec names the three tiers and binds producers to
them:

| Tier | Priority | Behavior | Examples |
|---|---|---|---|
| **Interrupt** | `urgent`, `high` | OS notification (even focused, for `urgent`), toast, inbox, badge | approval needed, task failed, health threshold, agent blocked |
| **Digest** | `normal` | inbox + unread badge, **no** OS interrupt while focused | task completed, workflow finished, proactive message worth surfacing |
| **Silent** | `low` | inbox only, no badge weight, auto-expires | routine confirmations, background completions |

**Producer rule:** an autonomous agent that interrupts for non-blocking events
trains the user to ignore interrupts (Android's channel lesson: apps that
abuse priority get muted wholesale, then miss the real one). Anything the user
does not need to *act on* is digest or silent. `NotificationService.notify`
callers must pass an explicit priority; category defaults may map to tiers
(`approval`→interrupt, `task`/`workflow`→digest, `system` routine→silent) but a
producer can always downgrade.

**Silent tier default expiry:** `low` notifications get a producer-side
`expiresAt` default (24h) so the inbox self-cleans. The self-destroy mechanic
already exists (`expiresAt`, honored on hydrate/notify/read).

### C.2 Where notifications live

One inbox, pinned on home: `NotificationsHomeCenter` directly below the
ambient base. This spec ratifies the existing decision (it replaced the
pull-down sheet; notifications live *on the dashboard*, not behind a gesture)
and the existing non-negotiables:

- **Not a slot widget** — pinned by `HomeScreen`, a registry declaration would
  double-render it. Keep.
- **Stable ordering** — priority bucket, then recency; read-state styles rows
  but never reorders them (tap-marks-read must not reshuffle under the
  finger). Keep.
- **Self-hides when empty.** Keep.
- Height-capped, internal scroll, `MAX_RENDERED_ROWS` cap. Keep.

### C.3 Grouping and coalescing

- **Supersede (exists):** `groupKey` — a newer notification with the same key
  replaces the older one. Correct for repeated reminders.
- **Count-aware coalescing (add):** when a producer emits N same-`groupKey`
  digest notifications in a window, the surviving record should carry the
  count ("3 tasks completed" not the last one silently eating two). Producer
  writes `data.count`; the row renders the count chip. One endpoint away —
  `NotificationService.notify` can increment on supersede.
- **Category sections (do NOT add):** the inbox is one chronological/priority
  stack, like the iOS lock screen — not a tabbed/categorized triage app.
  Categories drive icons and filtering in a future full-history view, not
  structure on home.

### C.4 The `useNow(60s)` re-render fix (binding pattern)

**Today:** `NotificationsHomeCenter` calls `useNow(60_000)` at the top of the
component, so every minute the *entire* inbox — up to 100 rows, each with
buttons, over a `backdrop-blur-xl` surface — re-renders to refresh "5m ago"
strings. `NotificationRow` is deliberately un-memoized because a stable-props
memo would pin "just now" forever. The diagnosis is right; the cure is wrong.

**The pattern (applies to every relative-timestamp surface in the app):**

1. Extract a leaf: `<RelativeTime ts={createdAt} />` which itself calls a
   shared `useNow` and renders the formatted string. The minute tick then
   re-renders **only the `<time>` text nodes**, not rows, not the list, not
   the glass surface.
2. Memoize `NotificationRow` on `(notification.id, readAt, title, body)` —
   safe once time rendering is out of the row's render path.
3. Make the shared ticker **visibility-gated**: one module-level interval
   (not one per leaf), subscribed via `useSyncExternalStore`, paused on
   `visibilitychange` when hidden and resynced on show. A backgrounded PWA
   burns zero timer wakeups.
4. Audit `backdrop-blur-xl`: the glass sits on the non-scrolling section
   (good), but a full-strength blur over an animated wallpaper is a
   per-frame compositing cost on iOS Safari. Reduce to the minimum radius
   that reads as glass, and provide the `supports-[backdrop-filter]`
   fallback as the primary path on low-end devices.

The same pattern fixes `DefaultHomeWidgets`' clock (its `useNow` re-renders
the weather tile alongside the time text every minute).

### C.5 Dismissal semantics

- **Tap row** = mark read + follow safe deep link. Read ≠ removed; the record
  stays as history. Never reorders (C.2).
- **X** = remove from inbox. Permanent for that record.
- **Mark-all-read** / **clear-all** = existing header actions. Keep.
- **`expiresAt`** = producer-declared self-destroy. Silent tier defaults to
  24h (C.1); interrupt tier never defaults an expiry (an unread approval
  request must not evaporate).
- **Acted-upon auto-read (add):** when the user completes the action a
  notification pointed at (approves the approval, opens the task), the
  producer should mark the corresponding notification read via `groupKey` —
  the inbox should never nag about a done thing.

---

## D. In-chat widget spec

### D.1 The artifact grammar — when the agent emits a widget vs text

A chat widget is the structured form of a conversational move. The closed
vocabulary (post #14524) maps to exactly five moves:

| Conversational move | Widget | Marker |
|---|---|---|
| "Pick one" | Choice | `[CHOICE]` |
| "I need these fields" | Form (+ date/time pickers, #14486) | `[FORM]` |
| "Here's what you could do next" | Followups | `[FOLLOWUPS]` |
| "I'm doing a multi-step thing" | Task / Workflow / Checklist | `[TASK]` `[WORKFLOW]` `[CHECKLIST]` |
| "Set up this integration" | Config / Connector | `[CONFIG:pluginId]` |

Plus the non-registry segments (permission card, secret/OAuth request, code
block, GenUI ui-spec) which are producing-action-backed.

**Emission rules:**

- **Text when the answer is prose.** A widget that could have been a sentence
  is chrome. Never emit a form for one field the user could just type; never
  emit a choice widget for yes/no when the user can say "yes".
- **Widget when structure removes ambiguity or typing.** ≥3 options → CHOICE.
  ≥2 required fields or any secret/date → FORM (with secrets always routed
  through the sensitive-request flow, never plain fields — #14326).
- **Widget when the thing is live.** Anything with progress or streaming
  state (task pipelines, workflows) is a widget, because text cannot update.
- **Code-emitted markers beat prompt guidance.** The action appends the
  marker; the model never needs the grammar in context. Preference order
  (board-15 synthesis, verbatim): *code-emitted markers > gated guide entry >
  new provider*. If guidance must be in-prompt it pays rent per token per
  turn — the `uiWidgets` budget ratchet (60 lines / 1200 tokens, test-enforced)
  is load-bearing and must never be relaxed without a fight.
- **Results render as widgets only when interactive or better-than-prose
  structured** (tables/charts via the GenUI path). A one-number answer is text.

### D.2 Lifecycle: artifacts scroll, they don't pin

- **Widgets scroll with the transcript.** They are utterances. No pinned
  widget area above/below chat, no drawer (Principle 8). The transcript *is*
  the history of artifacts.
- **Latest instance is live.** When the same logical widget is re-emitted
  (a checklist updated, a workflow advanced), the newest instance is the
  interactive one; older instances render as inert history. Display-only
  widgets (WORKFLOW, CHECKLIST) already work by re-emission — keep that model
  rather than mutating old messages.
- **Collapse-on-complete.** A widget whose job is done (form submitted,
  connector connected, choice made) auto-collapses to a one-line summary row
  with a chevron to re-expand — the `ChatWidgetShell` contract from #14412
  (start expanded while incomplete; collapse to summary on completion;
  standardized chevron). This spec adopts #14412's shell as the universal
  chat-widget chrome.
- **Re-invocation is conversational.** There is no "widget history" UI. To get
  a picker back, the user asks; the agent re-emits. Followup chips can offer
  the re-emit ("change my answer").
- **Density model (existing, keep):** glance card → expand-in-place →
  full view page (`TaskWidget` is the reference implementation). No widget
  adds a fourth density or its own navigation chrome.

### D.3 Alignment with the uiWidgets / uiGenerative split (#14521/#14524)

This spec **aligns with** lalalune's direction; it does not fork:

- **`uiWidgets`** (closed marker vocabulary, ~58 lines, budget-ratcheted) is
  the canonical path and the only prompt-cost the common turn pays. The five
  conversational moves in D.1 are its complete surface. New widget kinds must
  clear a high bar: they extend the *closed* vocabulary, add a parser + both
  surface renderers + connector projections, and update `WIDGET_MATRIX.md`.
- **`uiGenerative`** (JSONL patches + component catalog) stays the gated
  escape hatch for data-visualization intent only — with the in-get
  word-boundary gate + continuation signal, since `relevanceKeywords` is
  advisory metadata nothing consumes (#14528 autopsy). Dashboards, tables,
  charts route here; everything else uses the closed vocabulary.
- **One respectful addition, not a fork:** as home widgets converge on the
  same glance/expand shell as chat widgets, the *shell* (collapse contract,
  summary rows, containment) should be one shared component family, so the
  #14412 shell work serves both surfaces. This is an implementation
  convergence, not a change to the provider architecture.
- **Connector projection discipline (board-15 matrix):** in-app renders the
  full widget; button-capable connectors get the neutral projection
  (`toNeutralLayout`); button-less surfaces need the plain-text sibling
  projection (#14525's `toPlainTextFallback`). Config/setup cards stay
  in-app; connectors get a link-out + prose status. No projecting forms onto
  keyboards.

### D.4 Chat-widget perf budget

- A widget's internal state change (expand/collapse, field edit, connection
  status) must not repaint the transcript — the `memo` + WeakMap normalize
  cache invariants in `chat-transcript.tsx` / `chat-message.tsx` are locked
  by tests and stay binding.
- Collapsed and off-screen widgets carry `content-visibility: auto` /
  `contain` so N connector cards in a long transcript don't re-layout per
  frame (#14412 item 4, pairs with #14333).
- Time/status-bearing widget subtrees follow the `<RelativeTime>` leaf
  pattern (C.4) — the NotificationRow lesson generalizes.

---

## E. Migration map (today → target)

Inventory as of `develop` (post #14485), ordered by execution priority.

| # | Today | Verdict | Change | Size |
|---|---|---|---|---|
| 1 | `NotificationsHomeCenter` — `useNow(60s)` full-list re-render, un-memoized rows, `backdrop-blur-xl` | **keep + fix** | C.4 pattern: `<RelativeTime>` leaf, memoized rows, shared visibility-gated ticker, blur audit. Also fixes `DefaultHomeWidgets` clock tick. | M |
| 2 | `HOME_RENDER_CAP = 12` | **tighten** | Cap ranked residents at **5** (`WidgetHost.tsx`); wallpaper + base + notifications + 5 + chat bar is the whole surface. | S |
| 3 | `wallet.balance` home declaration | **demote** | Remove from `home` slot (component + routed view stay). Producer-side notification on material balance change replaces the resident card. | S |
| 4 | `health.sleep` home declaration | **demote** | Remove from `home` slot; `health` category notifications carry the alert case; routed view keeps the dashboard. | S |
| 5 | `goals.attention` home declaration | **merge** | At-risk goal renders as one flagged row inside the Today (todo) card; goals loses its standalone resident. | M |
| 6 | Notification coalescing | **add** | Count-aware `groupKey` supersede (`data.count`), silent-tier default `expiresAt`, acted-upon auto-read. | M |
| 7 | `needs-attention`, `calendar.upcoming`, `todo.items`, `model-download`, `agent-provisioning`, `ftu-welcome` | **keep** | The target resident set (§B). Calendar gains the 18h lookahead gate + `<RelativeTime>` countdown. | S |
| 8 | Chat widget shell (collapse-on-complete) | **tracked** | Already scoped as #14412 — this spec adopts its contract as universal; no new issue. | — |
| 9 | `HOME_CONTENT_TAXONOMY.md` / `WIDGET_MATRIX.md` | **update** | Point both at this spec as the north star once items 1–5 land (coordinate with #14327). | S |

Items 1–2 are pure wins with no product debate. Items 3–5 change the resident
set and should land as one reviewable sweep (same shape as #14485). Item 6 is
runtime + store. Item 7 is mostly ratification.

---

*Spec owner: this document. Amend by PR with rationale; the principles in §A
change only with a product-level decision.*

— [sol-orch]
