# Launcher widget audit (keep sparse)

## Summary

This is the widget audit for the launcher/home surface, part of converging the repo
into the **LifeOps Personal Assistant MVP** (GitHub project 15). The MVP is chat,
onboarding, the current views, and centrally LifeOps — scheduling, calendar,
coordination, reminders, goals, todos, tasks — serving children, adults with
ADHD/ADD/Asperger's/autism, neurotypical people, and elderly people with no therapy
language and no special rails. The guiding constraint is **minimize additional
scope**: fix, test, and verify what exists; prefer deleting over adding.

Doctrine adopted for the home surface: **date+time, weather, and notifications are
GOOD. A wallet widget is GOOD** (BTC/SOL/ETH prices by default; top-3 held when the
user holds tokens; ~3 trending otherwise). **Everything else is scrutinized for
removal.** Decision: the resting home becomes exactly time/weather + notification
center + wallet; the LifeOps attention cards (calendar, todos, needs-response,
goals, sleep) stay because they *are* the MVP and already self-hide when idle;
seven non-MVP widgets are removed from the home slot.

## Current state

The home surface is `HomeScreen` (`packages/ui/src/components/shell/HomeScreen.tsx:160-291`),
mounted at `/chat` by `HomeScreenMount` in `packages/ui/src/App.tsx:1699-1744` inside the
home↔launcher swipe rail (`packages/ui/src/components/shell/HomeLauncherSurface.tsx:31`).
The adjacent launcher page is a view-tile grid
(`packages/ui/src/components/pages/LauncherSurface.tsx`) — tiles, not widgets; out of
scope here. Composition, top to bottom:

1. **Always-on base** — `DefaultHomeWidgets` (`packages/ui/src/components/shell/DefaultHomeWidgets.tsx:131-202`): time/date/greeting + weather.
2. **Pinned notification center** — `NotificationsHomeCenter` (`packages/ui/src/components/shell/NotificationsHomeCenter.tsx`); deliberately NOT a ranked widget (double-render guard, `packages/ui/src/widgets/registry.ts:180-186`).
3. **Ranked widget grid** — `<WidgetHost slot="home" layout="grid">` (`packages/ui/src/widgets/WidgetHost.tsx:194`), attention-ranked by `rankHomeWidgets` (`packages/ui/src/widgets/home-priority.ts`), capped at `HOME_RENDER_CAP = 12` (`WidgetHost.tsx:122`).
4. **AOSP-only tiles** — messages/phone/contacts/camera, `nativeOs`-gated, render nothing on stock installs (`HomeScreen.tsx:107-138`).

### Full inventory (verified per file)

**Base tier (never ranked):**

| Widget | File | Shows | Data / cost |
|---|---|---|---|
| Time/date/greeting | `DefaultHomeWidgets.tsx:171-196` | 12-hour clock (hardcoded), weekday+date, time-of-day greeting | device clock via `useNow(60_000)` (`packages/ui/src/hooks/useNow.ts:15`); zero network; hideable via `homeTimeWidgetHidden` (#10706) |
| Weather | `DefaultHomeWidgets.tsx:82-129`, `packages/ui/src/hooks/useWeather.ts` | temp (°F hardcoded, `useWeather.ts:157`), condition, icon; city line is dead (device path returns `city: ""`, `useWeather.ts:138`) | Open-Meteo, no key; geolocation only if already granted (no prompt); 30-min localStorage cache; **one fetch per mount, never revalidates while mounted** (`useWeather.ts:176-204`) |
| Notification center | `NotificationsHomeCenter.tsx` | full inbox: priority-then-recency rows, unread dots, open/dismiss/mark-all-read/clear; self-hides when empty | notification store fed by WS `agent_event` — no polling; 100-row render cap (`NotificationsHomeCenter.tsx:52`) |

**Ranked `home`-slot widgets** (declared in `packages/ui/src/widgets/registry.ts:161-473`; all self-hide when empty unless noted):

| Widget id | File | Shows | Refresh |
|---|---|---|---|
| `welcome.ftu` | `components/chat/widgets/ftu-welcome.tsx` | first-run greeting + "try saying…" chips; retires permanently via sunset lifecycle (#9959) | prompt-suggestions; no poll |
| `needs-attention.pending` | `needs-attention.tsx` | oldest pending approval the agent is blocked on (`GET /api/approvals`) | 20 s, visibility-gated |
| `calendar.upcoming` | `calendar-upcoming.tsx` | single most imminent event ≤14 d out; urgent signal ≤2 h | 60 s, visibility-gated |
| `todo.items` | `todo.tsx` | up to 8 workbench todos | 15 s, visibility-gated |
| `goals.attention` | `goals-attention.tsx` | single most-urgent LifeOps goal | 20 s, visibility-gated |
| `health.sleep` | `health-sleep.tsx` | last night's sleep + "Irregular" badge; hides when rhythm healthy | 20 s, visibility-gated |
| `inbox.unread` | `inbox-unread.tsx` | top unread cross-channel thread + count | 20 s, visibility-gated |
| `finances.alerts` | `finances-alerts.tsx` | overdrawn balance + bills due ≤7 d | 30 s, visibility-gated |
| `relationships.attention` | `relationships-attention.tsx` | pending identity-merge, else stalest contact | 30 s, visibility-gated |
| `wallet.balance` | `wallet-balance.tsx` | top-5 *held* assets by unit price only (#10706); **hides entirely with no holdings** | one-shot fetch on auth — **prices never refresh** (`wallet-balance.tsx:62-89`) |
| `feed.agent-activity` | `agent-activity.tsx` | last 5 feed activity items + total | one-shot fetch, 6 s timeout |
| `agent-orchestrator.activity` | `agent-orchestrator.tsx` (`OrchestratorActivityWidget`) | latest activity event summary + count | WS `events` prop; no poll |
| `agent-orchestrator.apps` | `agent-orchestrator.tsx:474-516` (`AppRunsWidget`) | live orchestrator app runs | **5 s raw `setInterval`, NOT visibility-gated** (unlike every other widget), pushes `appRuns` into global AppContext |
| `workflow.running` | `automations.tsx` | "running" automations — but `isRunning` counts `status === "system"` rows (`automations.tsx` `isRunning`), which always exist, so **it never self-hides in practice: permanent chrome** | one-shot via `useUnifiedTasks` |
| `local-inference.model-download` | `model-download.tsx` | recommended local-model download progress (LOCAL mode); hides when ready | hub stream + 400 ms debounce |
| `cloud.agent-provisioning` | `agent-provisioning.tsx` | dedicated cloud-agent boot progress (CLOUD mode); hides once attached | status poll |

**No render-nothing participation records:** the legacy default-sink opt-ins
were deleted in #14349. Frontpage presence is now opt-in and curated: a
declaration resolves only when this build can render a registered component or a
`uiSpec`. `widget-coverage.test.ts` now guards those renderability and duplicate
ID invariants instead of enforcing a per-plugin breadth mandate.

**Gating that already limits the set:** widgets for LifeOps plugins only resolve on hosts
with full app-shell routes (`FULL_APP_SHELL_WIDGET_PLUGIN_IDS`, `WidgetHost.tsx:129-139`);
plugin-snapshot enable/disable is honored per declaration `visibility`
(`registry.ts:514-564`); every widget is wrapped in an error boundary (`WidgetHost.tsx:85`).

### What's weak / broken / untested

- **Wallet widget contradicts the adopted doctrine**: it hides with no holdings and never shows BTC/SOL/ETH baseline prices, and its one-shot fetch means displayed prices go stale for the whole session. The plumbing for the doctrine already exists: `GET /api/wallet/market-overview` (`plugins/plugin-wallet/src/routes/wallet-market-overview-route.ts:23-33`) serves fixed BTC/ETH/SOL snapshots (`MARKET_PRICE_IDS`, line 32; shared domain logic `packages/shared/src/wallet/market-overview.ts:24`) **plus** top movers (= trending) from CoinGecko, cached 120 s server-side; holdings come from `client.getWalletBalances()` with pure top-N selection in `wallet-price-holdings.ts:76-116`.
- **`AppRunsWidget` polls every 5 s with a raw `setInterval`** — the only home widget not gated on document visibility — and JSON-stringifies the run list every tick (`agent-orchestrator.tsx:471-516`). A backgrounded window keeps hitting the API forever.
- **`workflow.running` is permanent chrome** — system automations always exist, so the "attention-driven, self-pruning" home model (`packages/ui/src/widgets/HOME_CONTENT_TAXONOMY.md`) is violated by design.
- **Weather is US-only and can silently go stale**: °F hardcoded, 12-hour clock hardcoded in the time tile, no revalidation while mounted, dead "Enable location" copy with no tap affordance (`DefaultHomeWidgets.tsx:96-105`), city line unreachable.
- **Poll fan-out**: with all widgets active the home sustains ~9 concurrent pollers (5–60 s cadences) ≈ one request every ~2 s, plus 3 parallel calls/15 s from the sidebar accounts widget when the chat rail is open. The ranking itself is cheap and render-storm-guarded (`WidgetHost.render-storm.test.tsx`, `#9304` stability machinery at `WidgetHost.tsx:330-355`).
- Test coverage of the *composition* is real (`HomeScreen.test.tsx`, `DefaultHomeWidgets.test.tsx`, `useWeather.test.ts`, per-widget tests, `__e2e__/run-home-screen-e2e.mjs`), but there is **no test asserting the sparse resting state** (a healthy account with nothing urgent sees only time/weather + wallet).

## Design considerations

- **Self-hide is the sparseness mechanism.** The ranked grid already renders nothing when
  widgets have no data; removals should target widgets that (a) never self-hide,
  (b) duplicate the notification rail, or (c) serve non-MVP domains.
- **Chat is primary; the home is a glanceable field behind the floating chat.** Any widget
  is one tap from its full view; nothing on the home may be the only path to a feature
  (nothing currently is — every removal candidate has a routed view).
- **Removals do not need sink rows.** `widget-coverage.test.ts` now checks that declared
  widgets resolve to a renderable component or `uiSpec`, and that slot ids are unique. A
  plugin with an `elizaos.app` manifest is not required to be frontpage-aware.
- **Children/price-safety:** the wallet widget is price-only by prior decision (#10706 —
  never amounts or holding values), which is exactly right for shared/kid devices. Keep
  that invariant in the respec.
- **No new plumbing.** The wallet respec, weather fix, and removals all use endpoints and
  hooks that already exist (`market-overview`, `getWalletBalances`,
  `useIntervalWhenDocumentVisible`).

## Open questions → answers

**Q1. The wallet doctrine says "BTC, SOL, ETH by default" AND "otherwise ~3 trending" — which wins when the user holds nothing?**
A: Show BTC/SOL/ETH. The overview's `prices` array is exactly those three fixed snapshots
(`market-overview.ts:24`), so it is the zero-ambiguity default; `movers` (trending) ride
the same cached response, so use them only as fill when a fixed snapshot is missing from a
partial-source response. Trending-first would make the resting home nondeterministic and
attention-grabby — wrong for the ADHD/autism audience. If the owner wants trending-first,
it is a 3-line swap on the same data.

**Q2. Do the LifeOps attention cards (calendar/todo/goals/sleep/needs-response) survive a "keep sparse" audit?**
A: Yes. They are the MVP's subject matter (the mission names goals, todos, tasks,
sleep-rhythm management explicitly), they self-hide when idle, and the resting home stays
at doctrine-sparse (time/weather + notifications + wallet). Removing them would delete the
product, not the clutter. The e2e issue adds proof that they actually self-hide.

**Q3. Does removing home widgets break `widget-coverage.test.ts`?**
A: No, as of #14349. The pre-MVP doctrine ("every plugin must be frontpage-aware") pointed
the wrong way for the sparse MVP home, so the gate now checks only declared-widget
renderability and duplicate ids.

**Q4. Should the notification center become a ranked widget?**
A: No. It is the app's single notification surface and is pinned by design; a registry
declaration would double-render the inbox (`registry.ts:180-186`). Doctrine says
notifications are GOOD — keep the pin.

**Q5. Is the wallet widget appropriate as default-on for children/elderly?**
A: Yes as specced: price rows only, no balances, no amounts (#10706 invariant), tap opens
the wallet view which has its own gating. No per-widget hide toggle for MVP — the only
existing toggle precedent is the time tile (#10706), and adding a widget-settings surface
is scope we don't need.

**Q6. What about the AOSP tiles and the chat-sidebar widgets (music, browser status, orchestrator accounts/rooms)?**
A: Out of the home audit. AOSP tiles render nothing off-AOSP (zero cost). Sidebar widgets
are a chat-rail concern — except the `AppRunsWidget` 5 s ungated poll, which is fixed
wherever the component remains mounted (P1).

## Recommendation (minimal-scope MVP plan, ordered)

1. **P0 — Remove seven non-MVP home widgets** (home-slot declarations only):
   `agent-orchestrator.activity`, `agent-orchestrator.apps` (dev-orchestrator surfaces; the
   apps tile also carries the 5 s ungated poll), `feed.agent-activity` (duplicates activity
   + notifications), `workflow.running` (permanent chrome, never self-hides),
   `finances.alerts` (money is not in the MVP mission), `relationships.attention` (niche;
   merge prompts can flow through notifications), `inbox.unread` (duplicates the
   notification rail — messages already fold into it per #10697). Add sink participation
   rows where the coverage gate requires them. Views/sidebar entries stay.
2. **P0 — Respec the wallet widget to doctrine**: always visible; top-3 held (≥$1, priced)
   when holdings exist, else BTC/SOL/ETH snapshots; visibility-gated 60 s refresh; keep
   price-only invariant. Uses only existing `market-overview` + `getWalletBalances`.
3. **P1 — Fix the keepers' correctness**: locale-aware temperature unit + hour cycle,
   weather revalidation while mounted, remove the dead city line or populate it, actionable
   unavailable state.
4. **P1 — Gate the `AppRunsWidget` poll on document visibility** where it remains (chat
   sidebar), matching every other widget.
5. **P1 — Prove the sparse resting state**: extend the home e2e + `audit:app` loop with a
   "healthy quiet account" fixture asserting exactly time/weather + wallet render (+
   notification center only when notifications exist), and that each keeper appears when
   its data demands attention and disappears after.
6. **Done in #14349 — Retire the frontpage breadth mandate (#9143)**: deleted
   `default-home-widget-sink-optins.ts` and relaxed `widget-coverage.test.ts` from
   "every app plugin must be frontpage-aware" to "declared widgets must resolve", removing
   participation-record machinery that rendered nothing.

## Out of scope (explicit non-goals for MVP)

- No new widgets (no habits/streaks/screen-time cards, no trending-token discovery UI).
- No widget-settings/customization surface (reorder, per-widget hide) beyond the existing
  time-tile toggle.
- No changes to the launcher tile grid, curation, or the home↔launcher rail gestures.
- No changes to chat-sidebar/character/nav-page widget slots (except the poll gating fix).
- No second notification surface, no re-adding removed tiles behind flags.
- No server-side wallet/price plumbing — the existing `market-overview` route is enough.

## Proposed issues

1. `[launcher] Remove non-MVP home widgets (orchestrator activity+apps, feed activity, automations, finances, relationships, inbox)` — P0
2. `[launcher] Wallet widget: BTC/SOL/ETH by default, top-3 held, always visible, periodic refresh` — P0
3. `[launcher] Weather + clock correctness: locale units, hour cycle, stale revalidation, actionable unavailable state` — P1
4. `[launcher] Gate AppRunsWidget 5s poll on document visibility` — P1
5. `[launcher] Home resting-state e2e: prove the sparse home and keeper self-hide behavior` — P1
6. `[launcher] Retire the frontpage widget breadth mandate (#9143) and delete the sink participation table` — done in #14349
