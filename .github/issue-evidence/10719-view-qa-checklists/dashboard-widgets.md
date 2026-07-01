# Dashboard & Widgets — QA Checklist

Scope: the home `WidgetHost` slot and every home/sidebar widget under `packages/ui/src/widgets/*` and `packages/ui/src/components/chat/widgets/*` — notifications, todos, messages, wallet, workflow/tasks, feed agent-activity, agent-orchestrator apps+activity, music, per-plugin priority cards (calendar/goals/finances/health/relationships/inbox/needs-attention), FTU welcome, model-download / cloud-agent provisioning; plus the ranking core (`home-priority.ts`), self-attention store, dismissal/sunset store, visibility overrides, render-storm stability, and the shared `HomeWidgetCard`.

Legend: **[COVERED: path]** = a committed test exercises it. **[GAP]** = no committed automated coverage found. **[PARTIAL]** = adjacent behavior tested but the specific assertion is missing.

Cross-ref for design finding: `HomeWidgetCard` resting class `bg-black/55` and hover class `hover:bg-black/55` are IDENTICAL — the card has **zero visible hover feedback**, violating the "neutral resting → neutral-with-opacity hover" rule. Flagged in items below.

---

## WidgetHost (home slot container)

### Entry / Nav
- [ ] Home host mounts at `/chat` launch screen via `HomeScreen` → `<WidgetHost slot="home">` (`HomeScreen.tsx:210`). **[COVERED: WidgetHost.home-launch.test.tsx "mounts the host for the home slot"]**
- [ ] Home host also renders behind the floating chat overlay on the launcher `/views` surface. **[COVERED: app/test/ui-smoke/home-widget-priority.spec.ts]**
- [ ] `App.tsx:441` mounts a second `<WidgetHost slot="home" layout="stack">` — verify only ONE home host is visible per shell mode (no duplicate widget-host-home in DOM). **[GAP]**
- [ ] Fresh reload directly on `/views` or `/chat` re-resolves the same ranked widget set (no flash of unranked order). **[GAP]**
- [ ] `data-testid="widget-host-home"`, `data-slot="home"`, `data-layout` attributes present on the container. **[COVERED: home-widget-priority.spec.ts (queries widget-host-home)]**

### Primary interactions
- [ ] Home slot renders a fixed 4-column grid (`grid grid-cols-4 gap-2.5`); non-home grid layout stays responsive `1→2`; stack layout is a vertical flex column. **[COVERED: WidgetHost.test.tsx "defaults to a vertical stack but renders a responsive grid when layout=grid"]**
- [ ] Each widget's declared `size` maps to a static col/row-span class (`spanClassForSize`: cols 1/2/4, rows 1/2). **[COVERED: messages.test.tsx "applies the host-provided grid span"; "defaults to col-span-2"]**
- [ ] `hideWhenEmpty` (default true): when zero widgets resolve, render `fallback ?? null`. **[COVERED: WidgetHost.test.tsx "hides entirely when empty with no fallback"; "renders the fallback in place of an empty host"]**
- [ ] `fallback` shows when widgets resolve but all self-hide (measured via `childElementCount === 0` in `useLayoutEffect`). **[COVERED: WidgetHost.test.tsx "shows the fallback when resolved widgets all self-hide"]**
- [ ] `filter` prop drops declarations post-resolution (user visibility overrides layered on top of registry gate). **[GAP — filter path not unit-tested]**
- [ ] `uiSpec` widgets (no bundled component) render via `UiRenderer` and dispatch `WIDGET_UI_ACTION_EVENT` on action. **[COVERED: WidgetHost.test.tsx "renders uiSpec widgets and dispatches their actions"]**
- [ ] Server-declared plugin widgets (`plugin.widgets[]`) merge into resolution and override builtin by `pluginId/id`. **[COVERED: WidgetHost.test.tsx "passes server-declared plugin widgets into the registry resolver"]**
- [ ] Full-app-shell-only widgets (agent-orchestrator/calendar/finances/goals/health/inbox/needs-attention/relationships/todo) are hidden on limited cloud-agent bases (`supportsFullAppShellRoutes` false). **[COVERED: WidgetHost.test.tsx "hides full app-shell widgets on limited cloud agent bases"]**
- [ ] `activity` default-sink widgets hidden on limited cloud bases. **[PARTIAL — gated in same branch, not separately asserted]**

### State matrix
- [ ] Empty (no plugins, no data): only always-visible core cards resolve, all self-hide → fallback shows. **[COVERED: WidgetHost.home-launch.test.tsx "self-hides every card when there is no data"]**
- [ ] Populated (notifications present): notifications home card renders. **[COVERED: WidgetHost.home-launch.test.tsx "renders the notifications home widget when there is data"]**
- [ ] `HOME_RENDER_CAP = 12` bounds the pathological all-active render count. **[PARTIAL — cap passed to rankHomeWidgets; no test forces >12 active widgets]**
- [ ] Guest / unauthenticated: home host still resolves core widgets (no auth gate on WidgetHost). **[GAP]**
- [ ] `s.plugins` non-array → treated as `[]` (defensive `Array.isArray`). **[GAP]**

### Repeated / rapid-fire
- [ ] Rapid `now` ticks (60s useNow) with unchanged signals do NOT re-render any widget child (reference-stable `displayed`). **[COVERED: WidgetHost.render-storm.test.tsx "a `now` tick with unchanged signals does NOT re-render any widget child"]**
- [ ] A signal that changes ranking order DOES re-render children. **[COVERED: WidgetHost.render-storm.test.tsx "a signal that changes the ranking order DOES re-render"]**
- [ ] Rapid plugin-snapshot swaps that keep order but change declaration identity refresh the held `displayedRef`. **[PARTIAL — resolved-identity branch exists; no test drives a same-order component swap]**

### Back-and-forth / switching & recovery
- [ ] Navigate away from home mid-fetch and back: in-flight widget fetches are cancelled (`cancelled` flag) — no setState-after-unmount warning. **[PARTIAL — cancel flags in wallet/messages/activity; no test asserts the cleanup cancels a pending resolve]**
- [ ] Background the app/tab: `useIntervalWhenDocumentVisible` pauses widget polls (todo, others). **[GAP — hook not tested at widget level]**
- [ ] Re-entering home preserves ranked order (no reshuffle of equal-score widgets). **[COVERED: WidgetHost.home-rank.test.tsx "is deterministic — the ranked order is stable across re-renders"]**

### Fuzz / adversarial
- [ ] Malformed server widget declaration (bad slot) is filtered by `isWidgetSlot` before resolution. **[COVERED: serverDeclarations flatMap drops non-slot; PARTIAL — no explicit bad-slot test]**
- [ ] A widget component that THROWS is caught by `WidgetErrorBoundary` and renders the "failed to render" fallback (`widget-error-<id>`) without crashing the host. **[GAP — no test mounts a throwing widget]**
- [ ] Invariant: `widget-host-home` never renders more than `HOME_RENDER_CAP` children. **[GAP]**

### Input modalities / A11y / Geometry
- [ ] `contain: layout` on the host so a reorder/resize repaints within the host and never reflows the page. **[COVERED: WidgetHost.containment.test.tsx]**
- [ ] Tab focus order walks home cards in DOM (rank) order; Enter activates the focused card. **[GAP]**
- [ ] axe pass on the populated home host after ranking settles. **[GAP — home-widget-priority.spec asserts no page diagnostics but not axe on the host]**
- [ ] Reduced-motion: no animation on rank reorder (only `contain: layout` repaint). **[GAP]**

### Concurrency / races
- [ ] Multiple data widgets (wallet + messages + activity + workflows) fetch concurrently on first paint without cross-contaminating state. **[PARTIAL — each tested in isolation]**
- [ ] A ranking recompute racing an in-flight fetch resolve does not drop the resolved data. **[GAP]**

---

## Home priority ranking + self-attention float

### Ranking core (`home-priority.ts`)
- [ ] `baseHomeScore`: lower `order` → higher base (pinned widget leads); missing/invalid order → 100 (base 0); order > 100 clamps to non-negative. **[COVERED: home-priority.test.ts "baseHomeScore" ×3]**
- [ ] `homeSignalWeight`: urgent kinds (blocked/escalation=10, approval=9, welcome=8) outrank ambient (activity=1); unknown → activity. **[COVERED: home-priority.test.ts "homeSignalWeight" ×2]**
- [ ] `scoreHomeWidget`: base with no signals; fresh signal adds full weight; recency half-life decay; signals past max age contribute 0; only signals attributed to this widget count. **[COVERED: home-priority.test.ts "scoreHomeWidget" ×5]**
- [ ] `rankHomeWidgets`: live signal floats a low-base widget to top; quiet widgets order by base; caps to `maxVisible`; ties break deterministically by widget key; `minScore` hides declared-but-quiet; `maxVisible 0` returns nothing. **[COVERED: home-priority.test.ts "rankHomeWidgets" ×6]**
- [ ] Future-stamped signal (age < 0) counts as "now" (full weight, no decay). **[COVERED: recencyMultiplier `age<0` branch; PARTIAL — via self-attention `now` stamp test]**
- [ ] `homeSignalsFromEvents`: attributes an event to every widget whose `signalKinds` match; normalizes vocabulary (proactive-message→message); orchestrator lifecycle→workflow; orchestrator error→workflow (NOT escalation); never boosts a widget without signalKinds. **[COVERED: home-priority.test.ts "homeSignalsFromEvents" ×5]**
- [ ] `homeSignalsFromNotifications`: urgent→escalation weight; ignores read notifications; generic `notification` kind matches any priority; strongest matching weight wins. **[COVERED: home-priority.test.ts "homeSignalsFromNotifications" ×3]**
- [ ] `signalKindForEventType`: known kinds pass through, aliases normalize, typed AgentEventService streams map, unknown → activity. **[COVERED: home-priority.test.ts "signalKindForEventType" ×3]**

### Self-attention float (`home-attention-store.ts`)
- [ ] A published weight floats the publishing widget above a higher-base widget. **[COVERED: home-attention-store.test.ts "a published weight floats the publishing widget above a higher-base widget"]**
- [ ] Publishing the same weight twice is idempotent; clearing removes the boost. **[COVERED: home-attention-store.test.ts "publishing the same weight twice is idempotent"]**
- [ ] `usePublishHomeAttention`: publishes while weight > 0, clears on `null`/`0`, always clears on unmount. **[PARTIAL — store fns tested; the hook's unmount-clear not asserted via a mounted widget]**
- [ ] Self-published weight is stamped `now` at read time (age 0 = full weight, no decay). **[COVERED: WidgetHost consumes `{...entry, timestamp: now}`; PARTIAL — asserted indirectly in home-attention test]**
- [ ] Widget floats up on its OWN data (todo urgent → reminder weight; finances overdrawn → escalation). **[COVERED: home-priority-integration.test.ts "floats the widgets that need attention to the front"]**

### WidgetHost ranking integration
- [ ] Renders every home widget ranked by score (lower order first). **[COVERED: WidgetHost.home-rank.test.tsx "renders every home widget, ranked by score"]**
- [ ] A live high-weight activity event floats a subscribing low-base widget to the top. **[COVERED: WidgetHost.home-rank.test.tsx]**
- [ ] Default-sink participant declarations are NOT rendered as duplicate cards. **[COVERED: WidgetHost.home-rank.test.tsx "does not render default-sink participant declarations as duplicate cards"]**
- [ ] Per-plugin cards register with attention signalKinds; float on need; quiet home ranks by base order. **[COVERED: home-priority-integration.test.ts ×5]**
- [ ] Live e2e: overdrawn balance / at-risk goal / urgent notification widgets rank at the TOP of `widget-host-home` (DOM order = rank order). **[COVERED: app/test/ui-smoke/home-widget-priority.spec.ts "ranks attention-worthy home widgets first"]**

### Fuzz / adversarial
- [ ] NaN / Infinity `order` → defaults to base 0 (not a crash / not top rank). **[COVERED: baseHomeScore Number.isFinite guard + test]**
- [ ] A signal with `widgetKey` matching no rendered widget is silently ignored. **[PARTIAL]**
- [ ] Thousands of signals for one widget do not overflow the score or hang the sort. **[GAP]**

---

## Dismissal / sunset lifecycle (`home-dismissal-store.ts`, FTU welcome)

### Store logic
- [ ] `isHomeWidgetSunset`: never sunsets a no-policy widget; retires `dismissible` once dismissed; retires `afterAction` once acted; retires `afterSeen: N` only AFTER seen in > N sessions. **[COVERED: home-dismissal-store.test.ts "isHomeWidgetSunset" ×4]**
- [ ] `recordHomeWidgetSeen` counts a session-view only once per session (re-mount on nav must not inflate toward `afterSeen`). **[COVERED: home-dismissal-store.test.ts "counts a session-view only once per session"]**
- [ ] `markHomeWidgetActed` / `dismissHomeWidget` persist `acted`/`dismissed` to localStorage. **[COVERED: home-dismissal-store.test.ts "persists acted + dismissed to localStorage"]**
- [ ] Corrupt persisted value survives without throwing (starts clean). **[COVERED: home-dismissal-store.test.ts "survives a corrupt persisted value without throwing"]**
- [ ] Retirement persists across reload (localStorage re-read on module init). **[PARTIAL — persistence tested; reload re-read not e2e'd]**
- [ ] `mutate` no-ops when next state equals prev (no redundant persist/emit). **[GAP — early-return branch untested]**

### FTU welcome widget interactions
- [ ] Renders greeting + suggestion chips on home slot; renders nothing off home. **[COVERED: ftu-welcome.test.tsx "renders the greeting + suggestion chips"; "renders nothing off the home slot"]**
- [ ] Tapping a chip prefills the chat (`dispatchChatPrefill`) and marks the card acted. **[COVERED: ftu-welcome.test.tsx "tapping a chip prefills the chat and marks the card acted"]**
- [ ] Dismiss control retires the card. **[COVERED: ftu-welcome.test.tsx "the dismiss control retires the card"]**
- [ ] A `message_received`/`message_sent` event retires the card; unrelated activity does not. **[COVERED: ftu-welcome.test.tsx "does not retire for unrelated activity"]**
- [ ] Declares `sunset: { afterAction: true, dismissible: true }`. **[COVERED: ftu-welcome.test.tsx "declares the show-once-then-retire sunset policy"]**
- [ ] Rapid double-tap the dismiss button → single dismissal, card gone, no double-persist. **[GAP]**
- [ ] Tap a chip AND dismiss in the same frame → deterministic retire (acted OR dismissed). **[GAP]**
- [ ] Chip focus order + Enter activation; dismiss reachable via keyboard. **[GAP]**
- [ ] Suggestion chips hover: `text-white/75 → hover:text-white hover:underline` (neutral, no orange/blue). **[GAP — not asserted]**

---

## Notifications widget (`notifications.recent`, always-visible core)

### Entry / Nav
- [ ] Resolves on home even with NO plugins (core feature via `ALWAYS_VISIBLE_BUILTIN_WIDGET_PLUGIN_IDS`). **[COVERED: registry.home.test.ts "resolves the Notifications widget on home even with NO plugins"; "keeps Notifications always-visible"]**
- [ ] Home card tap → opens the notification's `deepLink` if present, else `/inbox`. **[COVERED: notifications.test.tsx "clicking the card navigates to the inbox"; "prefers the notification's own deep link"]**

### Primary interactions / State
- [ ] Home slot: ONE compact card = top (unread-first, priority-ranked) notification + unread badge; urgent→danger tone, high→warn. **[COVERED: notifications.test.tsx "home slot: ONE compact, icon-first card"]**
- [ ] `rankHomeNotifications` content order: unread before read; higher priority; then recency; stable for equal items. **[COVERED: home-priority.test.ts "rankHomeNotifications" ×4]**
- [ ] Chat-sidebar slot: keeps the list (a row per notification), not a single card. **[COVERED: notifications.test.tsx "chat-sidebar slot: keeps the existing list"]**
- [ ] Empty (no notifications): renders nothing on home (no placeholder). **[COVERED: notifications.test.tsx "renders nothing when there are no notifications"]**
- [ ] `MAX_HOME_NOTIFICATIONS = 4` cap on the ranked slice. **[PARTIAL — slice(0,4) not directly asserted with >4 items]**

### Rapid-fire / fuzz / a11y
- [ ] Mash the card 5× → exactly one nav per activation, no duplicate `eliza:navigate:view` storm / dedupe. **[GAP]**
- [ ] Notification with huge/emoji/RTL title truncates (`truncate` class) and does not overflow the card. **[GAP]**
- [ ] Notification with no `body` renders title only (no empty body span). **[COVERED: NotificationRow conditional; PARTIAL]**
- [ ] Card `aria-label` carries full meaning ("N unread, latest X. Open inbox."). **[COVERED: home slot test asserts card + label; PARTIAL]**
- [ ] Card hover: no visible feedback because `bg-black/55 == hover:bg-black/55` — **FINDING, needs fix + test**. **[GAP]**

---

## Messages widget (`messages.recent`, always-visible curated tile)

### Entry / Nav / interactions
- [ ] Resolves on home (curated home-grid tile). **[COVERED: registry.home.test.ts "resolves the Recent conversations widget on home"]**
- [ ] Home card tap → `/messages` view. **[COVERED: messages.test.tsx "clicking the card navigates to the Messages view"]**
- [ ] Home slot: ONE card = most-recent QUALIFYING conversation name + `+N` overflow badge + relative time meta. **[COVERED: messages.test.tsx "home slot: ONE compact, icon-first card"]**
- [ ] Chat-sidebar slot: a row per qualifying conversation. **[COVERED: messages.test.tsx "chat-sidebar slot: keeps the existing list"]**

### State matrix
- [ ] Qualification filter: only conversations where an assistant message follows a user message (real exchange), never empty drafts / greeting-only. **[COVERED: messages.test.tsx "skips conversations where the agent has not responded"; "self-hides when no conversation has a real agent exchange"]**
- [ ] Derives a short name from the latest user message when the title is a server default (`GENERIC_TITLES`). **[COVERED: messages.test.tsx "derives a short name from the latest user message"]**
- [ ] Empty conversations → renders nothing. **[COVERED: messages.test.tsx "renders nothing when there are no conversations"]**
- [ ] Cold home seeds from `client.listConversations()` when store empty; does NOT seed when store already populated. **[COVERED: messages.test.tsx "cold home: seeds from client.listConversations()"; "does not seed when the store already has conversations"]**
- [ ] Grid span: applies host `spanClassName`; defaults to `col-span-2` when absent. **[COVERED: messages.test.tsx "applies the host-provided grid span"; "defaults to col-span-2"]**

### Repeated / recovery / fuzz
- [ ] `getConversationMessages` per-candidate fetches are cancelled on unmount (`cancelled` flag) — no late setState. **[PARTIAL — flag exists, no test]**
- [ ] `listConversations` rejects → `setSeeded([])`, widget self-hides (no error card). **[COVERED: `.catch` sets []; PARTIAL — rejection path not directly asserted]**
- [ ] `getConversationMessages` rejects for one candidate → `setQualifying([])`, self-hide. **[PARTIAL]**
- [ ] `MAX_SCANNED_CONVERSATIONS = 8` bounds the fetch fan-out; `MAX_HOME_CONVERSATIONS = 4` bounds display. **[GAP — cap not asserted with >8 conversations]**
- [ ] Title with `\s+` runs / 40+ char / emoji collapses+clamps via `shortenName` (`DERIVED_NAME_MAX_LEN`). **[PARTIAL — derive test exists; overflow/emoji not fuzzed]**
- [ ] Leave home while message fetches in flight, return → no duplicate rows, correct qualifying set. **[GAP]**

---

## Wallet widget (`wallet.balance`, always-visible core surface)

### Entry / Nav / interactions
- [ ] Resolves on home (fallback plugin id `wallet`). **[COVERED: registry resolution via ALWAYS_VISIBLE; PARTIAL]**
- [ ] Home card tap → `/wallet` view. **[PARTIAL — onActivate wired; nav not asserted in wallet-balance.test]**
- [ ] Renders aggregate USD total + chain-count badge when populated; singular "chain" for one network. **[COVERED: wallet-balance.test.tsx "renders the aggregate USD total"; "uses the singular 'chain' label"]**

### State matrix
- [ ] Loading placeholder (`chat-widget-wallet-balance-loading`, `aria-busy`) until balances resolve. **[COVERED: wallet-balance.test.tsx "renders a loading placeholder until the balances resolve"]**
- [ ] Balance-gated empty: both EVM+Solana null → renders nothing. **[COVERED: wallet-balance.test.tsx "renders nothing when both EVM and Solana are null"]**
- [ ] Balances sum to zero → renders nothing. **[COVERED: wallet-balance.test.tsx "renders nothing when balances sum to zero"]**
- [ ] `getWalletBalances` rejects → `setData(null)` → self-hide (no error card surfaced). **[COVERED: `.catch` in effect; PARTIAL — rejection not directly asserted]**
- [ ] Offline / endpoint unreachable → same self-hide path (silent). **[GAP — NOTE: no user-visible offline state; design gap]**

### Fuzz / adversarial
- [ ] `parseUsd` degrades malformed / NaN / `"abc"` string values to 0 (finite guard). **[COVERED: parseUsd Number.isFinite; PARTIAL — not fuzzed with NaN strings in a test]**
- [ ] Negative net balance still gated out (`totalUsd <= 0` → null). **[PARTIAL]**
- [ ] Huge total (e.g. 1e12) formats via `Intl.NumberFormat` currency without breaking the tile layout. **[GAP]**
- [ ] `Intl.NumberFormat` throwing (bad locale) falls back to `$value.toFixed(2)`. **[COVERED: formatUsd try/catch; GAP — fallback not tested]**

### Recovery / races
- [ ] Unmount mid-fetch: `cancelled` guard blocks the resolve's setState. **[PARTIAL — flag exists, untested]**
- [ ] Grid span applied from `props.spanClassName ?? DEFAULT_SPAN`. **[PARTIAL]**

---

## Workflow / Tasks widget (`workflow.running`, always-visible)

### Entry / Nav / interactions
- [ ] Home card tap → `/automations` view. **[COVERED: workflows.test.tsx "navigates to the automations view on activate"]**
- [ ] Shows top running task title + `+N` badge for the rest. **[COVERED: workflows.test.tsx "shows the top running workflow and a +N badge"]**
- [ ] Merges `GET /api/automations` + `GET /api/lifeops/scheduled-tasks` via `useUnifiedTasks` (no second scheduler). **[COVERED: workflows.test.tsx "surfaces a boot-seeded scheduled task as the running task"]**

### State matrix
- [ ] Loading card ("Loading…") before fetch resolves. **[COVERED: workflows.test.tsx "renders a loading card before the fetch resolves"]**
- [ ] `isRunning` filter: system tasks + enabled active user workflows + active LifeOps tasks; excludes paused/draft/completed. **[COVERED: workflows.test.tsx "excludes paused, draft, and completed"; "excludes a paused (manual-trigger) seeded recap"]**
- [ ] Self-hides when nothing running. **[COVERED: workflows.test.tsx "self-hides when nothing is running"]**
- [ ] Self-hides when the automations endpoint fails / 404 (mobile). **[COVERED: workflows.test.tsx "self-hides when the automations endpoint fails"]**
- [ ] `TASKS_TIMEOUT_MS = 6000`: a hung channel settles the tile (self-hide) not infinite spinner. **[PARTIAL — timeout wired; no fake-timer test asserting the hang→settle]**
- [ ] `compareRunning` order: system first, then by title. **[PARTIAL — covered indirectly by +N test]**

### Rapid-fire / fuzz / a11y
- [ ] Mash the card → single nav per tap. **[GAP]**
- [ ] Running task with huge/emoji/RTL title truncates. **[GAP]**
- [ ] Grid span applied to root. **[COVERED: workflows.test.tsx "applies the provided span class to the root grid item"]**

---

## Feed / Agent-activity widget (`feed.agent-activity`, always-visible)

### Entry / Nav / interactions
- [ ] Home card tap → opens the feed view. **[COVERED: agent-activity.test.tsx "opens the feed view when activated"]**
- [ ] Shows most-recent activity summary + `+N` badge. **[COVERED: agent-activity.test.tsx "shows the most-recent activity summary plus a +N badge"]**
- [ ] Falls back to `contentPreview` then humanised type when `summary` absent (always non-empty datum). **[COVERED: agent-activity.test.tsx "falls back to contentPreview when summary is absent"]**

### State matrix
- [ ] Loading state before first fetch settles. **[COVERED: agent-activity.test.tsx "renders a loading state before the first fetch settles"]**
- [ ] Settled with zero items → renders nothing (zero-setup, no placeholder). **[COVERED: agent-activity.test.tsx "renders nothing after a settled load with zero items"]**
- [ ] Request fails → settles to empty (renders nothing). **[COVERED: agent-activity.test.tsx "settles to empty when the request fails"]**
- [ ] `ACTIVITY_TIMEOUT_MS = 6000` (`withTimeout`) bounds a hung channel → empty not stuck-loading. **[PARTIAL — wired; no fake-timer hang test]**
- [ ] `activityItemsFrom` validates untrusted network shape (keeps only items with string id/type/timestamp). **[PARTIAL — validator exists; not fed a malformed payload in a test]**

### Fuzz / a11y
- [ ] Malformed feed payload (non-array, missing fields, injection strings in summary) → filtered out, no crash. **[GAP]**
- [ ] Grid span applied to root. **[COVERED: agent-activity.test.tsx "applies the received spanClassName"]**
- [ ] Mash card → single nav. **[GAP]**

---

## Agent-orchestrator widgets (apps + activity)

### Entry / Nav / resolution
- [ ] `agent-orchestrator.activity` resolves on home slot with its component. **[COVERED: registry.home.test.ts "resolves the agent-orchestrator Activity widget on the home slot"]**
- [ ] `agent-orchestrator.apps` resolves on home (reused AppRunsWidget component). **[COVERED: registry.home.test.ts "resolves the agent-orchestrator Apps widget on home"]**
- [ ] The chat-sidebar Activity declaration stays on its own slot (home doesn't steal it). **[COVERED: registry.home.test.ts "keeps the chat-sidebar Activity declaration on its own slot"]**

### Interactions / State
- [ ] Home Activity card: latest event summary + relative time + event-count badge; tap → Tasks tab (`nav.openTab("tasks")`). **[COVERED: agent-orchestrator.test.tsx / component tests; PARTIAL — home-slot tap-to-tasks not directly asserted]**
- [ ] Chat-sidebar Activity: full list + Clear (`Trash2`) button dispatching `clearEvents`. **[COVERED: agent-orchestrator.test.tsx]**
- [ ] Clear button `aria-label` present; clears the event list. **[PARTIAL]**
- [ ] Apps widget lists live app RUNS (distinct from launcher icons). **[COVERED: agent-orchestrator.stories.tsx + test]**
- [ ] Empty events on home → self-hide (no latest event). **[GAP — home-slot early return on empty events not asserted]**

### Rapid-fire / a11y
- [ ] Spam Clear button → idempotent (list stays empty, no error). **[GAP]**
- [ ] Home Activity card mash → single Tasks tab switch. **[GAP]**

---

## Todo widget (`todo.items`)

### Entry / Nav / resolution
- [ ] Resolves on home (per-plugin breadth opt-in, fallback plugin id `todo`). **[COVERED: registry.home.test.ts "resolves the Todos widget on home"]**
- [ ] Sidebar `chat-widget-todos` section with rows. **[COVERED: task-widget/todo stories; PARTIAL — todo.tsx has no co-located *.test.tsx]**

### Interactions / State
- [ ] `dedupeTodos` + `sortTodosForWidget`: incomplete before completed, urgent before normal, then priority, then name. **[GAP — no todo.test.tsx (todo.stories.tsx only)]**
- [ ] Home slot with no OPEN todos → renders nothing (`onHome && openTodos.length === 0`). **[GAP]**
- [ ] `usePublishHomeAttention` floats the todo card up on urgent open todos (reminder weight); clears otherwise. **[PARTIAL — store tested; widget-level publish untested]**
- [ ] `MAX_VISIBLE_TODOS = 8` + "+N more open" + "N completed hidden" summaries. **[GAP]**
- [ ] Loading ("Refreshing todos…") when empty+loading. **[GAP]**
- [ ] `listWorkbenchTodos` rejects → keeps store todos if any (`workbench?.todos`). **[GAP]**
- [ ] `TODO_REFRESH_INTERVAL_MS = 15000` poll paused while document hidden (`useIntervalWhenDocumentVisible`). **[GAP]**
- [ ] `mountedRef` guards post-await setState after unmount. **[GAP]**

### Fuzz / a11y
- [ ] Urgent/priority/type badges render conditionally (no empty badge for `type === "task"`). **[GAP]**
- [ ] Long todo name/description clamps (`line-clamp-2`, `truncate`). **[GAP]**

> Todo widget has **stories only, no `*.test.tsx`** — the largest single-widget behavior gap in the group.

---

## Music-library widget (`music-library.playlists`, `character` slot)

- [ ] Resolves on the `character` slot (not home). **[PARTIAL — registry declaration; no dedicated test]**
- [ ] Renders nothing when `pluginState?.enabled === false`. **[GAP]**
- [ ] Populated playlists render; empty → appropriate empty/hide. **[GAP]**

## Music-player widget (`chat-sidebar`)
- [ ] Resolves on chat-sidebar; `MUSIC_PLAYER_WIDGET.defaultEnabled`. **[COVERED: music-player.stories.tsx; PARTIAL]**
- [ ] Play/pause/next controls fire their handlers. **[GAP]**

---

## Per-plugin home-priority cards (calendar / goals / finances / health / relationships / inbox / needs-attention)

### Resolution + gating
- [ ] Each resolves >= 1 home widget for its app-manifest plugin (coverage gate). **[COVERED: widget-coverage.test.ts "resolves >=1 home widget for every app-manifest plugin"]**
- [ ] Own-widget vs default-sink split reported; no-declaration fails / default-sink opt-in passes (red/green control). **[COVERED: widget-coverage.test.ts ×2]**
- [ ] Resolve only when the plugin is enabled+active in the runtime snapshot (except the always-visible core-backed ones: calendar/relationships/needs-attention). **[COVERED: registry `isWidgetEnabled` + ALWAYS_VISIBLE set; PARTIAL per-card]**

### Per-card behavior (each of calendar/goals/finances/health/relationships/inbox/needs-attention)
- [ ] Loading → populated → empty(self-hide) → error(self-hide) states. **[COVERED: each has *.test.tsx: calendar-upcoming/goals-attention/finances-alerts/health-sleep/relationships-attention/inbox-unread/needs-attention.test.tsx]**
- [ ] Self-publishes home-attention weight on its own urgency (overdrawn/at-risk/imminent/irregular/pending-merge). **[COVERED: finances/goals/health/calendar/relationships tests + home-priority-integration.test.ts]**
- [ ] Home card tap → the plugin's full view. **[PARTIAL — per-card nav assertions vary; verify each]**
- [ ] `needs-attention` backed by core ApprovalService (`GET /api/approvals`), always-visible, self-hides when nothing pending. **[COVERED: needs-attention.test.tsx]**

### Fuzz / a11y (per-card)
- [ ] Huge/emoji/RTL data value truncates; NaN numeric degrades gracefully. **[GAP across all cards]**
- [ ] Card hover feedback (same `bg-black/55` no-op hover finding). **[GAP]**
- [ ] Card tap targets >= 44px on mobile viewport. **[GAP]**

---

## Model-download / Cloud-agent provisioning setup tiles

### Model-download (LOCAL mode)
- [ ] States: queued / %-progress / loading / failed-with-retry; self-hides when no local model required or all ready. **[COVERED: model-download.test.tsx]**
- [ ] Retry control re-triggers the download. **[COVERED: model-download.test.tsx / stories; PARTIAL]**
- [ ] Rapid Retry mashing → single download kick, no duplicate jobs. **[GAP]**

### Cloud-agent provisioning (CLOUD mode)
- [ ] Shows background setup + Retry while a dedicated cloud agent boots; self-hides once attached or pure-local. **[COVERED: agent-provisioning.test.tsx]**
- [ ] Retry control re-triggers provisioning. **[COVERED: agent-provisioning.test.tsx; PARTIAL]**

---

## Render-storm stability (cross-cutting)

- [ ] `now` tick with unchanged signals → NO widget child re-render (reference-stable `displayed`/`children` memo). **[COVERED: WidgetHost.render-storm.test.tsx]**
- [ ] Ranking-changing signal → children re-render (priority stays live, lock can't pass by freezing UI). **[COVERED: WidgetHost.render-storm.test.tsx]**
- [ ] `orderKey` join dedupes re-renders across ticks; `displayedRef` swaps only on order OR resolved-identity change. **[COVERED: render-storm + rank determinism tests]**
- [ ] Live e2e: no console/page diagnostics while the ranked home is mounted and re-settling. **[COVERED: home-widget-priority.spec.ts `expectNoPageDiagnostics`]**
- [ ] 30+ minute soak with a 60s tick loop → no memory growth / no re-render accumulation. **[GAP]**

---

## WidgetErrorBoundary (cross-cutting)

- [ ] A widget that throws in render shows `widget-error-<id>` fallback ("Widget ... failed to render") and does not crash the host. **[GAP — no test mounts a throwing widget]**
- [ ] A neighboring widget still renders after one widget errors (isolation). **[GAP]**
- [ ] Error fallback uses `border-danger/30 bg-danger/5` (no blue). **[GAP]**

---

## HomeWidgetCard (shared building block)

- [ ] `onActivate` fires on click and on Enter (it is a `<button>`). **[PARTIAL — asserted via each widget's click test; keyboard Enter GAP]**
- [ ] Tone maps: default→white value, danger→danger + dot, warn→warn + dot; badge tone matches. **[PARTIAL — asserted via notifications urgent/high]**
- [ ] `value` truncates (`truncate text-sm`); `meta` tabular-nums; `badge` pill. **[PARTIAL]**
- [ ] `title` (hover tooltip) = label; `aria-label` carries full meaning (icon-only visible). **[PARTIAL]**
- [ ] **FINDING: resting `bg-black/55` == `hover:bg-black/55` → no hover state change.** Must become a real neutral-opacity hover (e.g. `hover:bg-black/70`) per the hover system; add a test asserting resting != hover class. **[GAP — bug + missing test]**
- [ ] Double/triple-click the card → `onActivate` semantics idempotent (nav dedupe / single view switch). **[GAP]**
- [ ] Card min tap target >= 44px on mobile; focus ring visible on Tab. **[GAP]**
- [ ] Right-click / long-press does nothing destructive (no context menu wired). **[GAP]**

---

## Widget visibility overrides + registry resolution (cross-cutting)

- [ ] `widgetVisibilityKey` composes `pluginId/id`; explicit override beats `defaultEnabled`; falls back to `defaultEnabled` (true when omitted). **[COVERED: visibility.test.ts ×3]**
- [ ] `applyChatSidebarVisibility` drops hidden widgets, preserves input order. **[COVERED: visibility.test.ts "drops hidden widgets and preserves input order"]**
- [ ] `load/saveWidgetVisibility` round-trips through localStorage; clears storage when no overrides remain; ignores malformed persisted values. **[COVERED: visibility.test.ts ×3]**
- [ ] Home widget visibility key isolated from the legacy chat-sidebar key. **[COVERED: visibility.test.ts "keeps home widget visibility isolated"]**
- [ ] `resolveWidgetsForSlot`: server declarations override builtin by id; sorted by `order`; includes a widget only with a Component OR uiSpec. **[COVERED: registry.home.test.ts + registry.defaultWidget.test.ts + registry-store.test.ts]**
- [ ] `DEFAULT_WIDGET_SINK_COMPONENT`: a home plugin with `defaultWidget` but no own component borrows the shared sink; never overrides an own component; never fires off home slot. **[COVERED: registry.defaultWidget.test.ts]**
- [ ] Widget slot contract: active slot list limited to supported surfaces; no bundled declarations on retired slots. **[COVERED: widget-coverage.test.ts "widget slot contract" ×2]**
- [ ] Chat-sidebar slot resolves every expected widget with a rendered component. **[COVERED: widget-coverage.test.ts "resolves every expected chat-sidebar widget"]**

---

## Coverage summary

| View / surface | Existing test path(s) | Biggest gap |
| --- | --- | --- |
| WidgetHost (home) | widgets/WidgetHost.test.tsx, WidgetHost.home-launch.test.tsx, WidgetHost.home-rank.test.tsx, WidgetHost.containment.test.tsx, WidgetHost.render-storm.test.tsx | No test mounts a THROWING widget → WidgetErrorBoundary fallback unproven; `filter` prop untested; dual-host (App.tsx + HomeScreen) dedupe unverified |
| Home priority ranking | widgets/home-priority.test.ts, home-priority-integration.test.ts | Signal-flood / score-overflow adversarial; unmatched-widgetKey signal |
| Self-attention float | widgets/home-attention-store.test.ts | `usePublishHomeAttention` unmount-clear not asserted via a mounted widget |
| Dismissal / sunset (FTU) | widgets/home-dismissal-store.test.ts, components/chat/widgets/ftu-welcome.test.tsx | Rapid double-dismiss idempotency; chip+dismiss same-frame race; keyboard/hover |
| Notifications | components/chat/widgets/notifications.test.tsx, notifications.populated.test.tsx | Rapid-fire card-tap nav dedupe; overflow/emoji truncation; no-op hover |
| Messages | components/chat/widgets/messages.test.tsx, messages.populated.test.tsx | Fetch cancellation-on-unmount unproven; scan-cap fuzz; leave-and-return dedupe |
| Wallet | components/chat/widgets/wallet-balance.test.tsx | Intl fallback path + huge-number layout + NaN-string fuzz untested; silent offline (no visible state) |
| Workflow / Tasks | components/chat/widgets/workflows.test.tsx | 6s hang→settle (fake-timer) unproven; rapid nav; long-title truncation |
| Feed / agent-activity | components/chat/widgets/agent-activity.test.tsx | Malformed/injection payload through `activityItemsFrom` not fed in a test |
| Agent-orchestrator apps+activity | components/chat/widgets/agent-orchestrator.test.tsx, .stories.tsx | Home-slot empty self-hide + tap→Tasks tab not directly asserted; Clear spam idempotency |
| **Todo** | components/chat/widgets/todo.stories.tsx **(no `*.test.tsx`)** | **Entire widget behavior (dedupe/sort/self-hide/attention/poll/error) has stories only — no behavioral test** |
| Music library / player | music-player.stories.tsx | `pluginState.enabled === false` hide and playback controls untested |
| Per-plugin priority cards | calendar-upcoming / goals-attention / finances-alerts / health-sleep / relationships-attention / inbox-unread / needs-attention .test.tsx | Fuzz (emoji/RTL/NaN) + 44px tap targets + hover contract across all seven |
| Setup tiles (model-download / cloud-agent) | model-download.test.tsx, agent-provisioning.test.tsx | Rapid Retry mashing → duplicate-job dedupe |
| HomeWidgetCard | (via each widget's click test) | **`bg-black/55 == hover:bg-black/55` = zero hover feedback (bug); keyboard Enter, 44px, double-click idempotency all GAP** |
| Widget visibility / registry | widgets/visibility.test.ts, registry.home.test.ts, registry.defaultWidget.test.ts, registry-store.test.ts, widget-coverage.test.ts | Solid — mainly interaction-layer (not resolution) gaps remain |

### Two cross-cutting findings to fix + guard
1. **Zero hover feedback** on `HomeWidgetCard` (`bg-black/55` resting AND hover) — violates the neutral-opacity hover rule; affects every home card. No test asserts resting != hover.
2. **Silent-failure design**: wallet/workflows/messages/feed all self-hide on fetch error/offline with NO user-visible error or offline state. Intentional per #9143 (clean home), but there is no committed test proving each rejection path resolves to the hidden state (only `.catch` code), and no offline surface anywhere.

### Biggest interaction-layer gap
The **entire group is unit-strong but interaction-weak**: only ONE e2e (`home-widget-priority.spec.ts`) touches the live home, and it asserts ranking + screenshots only — never a card TAP, the FTU dismiss, keyboard/focus order, axe on the host, 44px targets, rapid-fire nav idempotency, or the WidgetErrorBoundary fallback. Plus the **Todo widget has stories but no `*.test.tsx` at all**.
