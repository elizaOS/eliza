# LifeOps Decomposition — Plan & Status (living doc)

> Source-of-truth tracker for breaking the `plugin-personal-assistant` (LifeOps)
> monolith into focused plugins, fully tested + reviewed across all 5 platforms.
> Architecture invariants live in `../README.md`; this doc tracks the *migration*.

Last assessment: 2026-06-17.

## Where we actually are

The decomposition is **scaffolded, not migrated**. Plugin shells + registered
(empty) views + `not_implemented` actions exist for every target domain, but the
real implementation (~157k LOC) still lives in `plugin-personal-assistant` (PA).

| Plugin | State | Evidence |
|---|---|---|
| `plugin-calendar` | ✅ **REAL** (reference pattern) | heavy logic in plugin; PA imports `CalendarService`; 73 unit tests pass |
| `plugin-health` | ✅ **REAL** (reference pattern) | bridge in plugin; PA mixins import factories; 58 unit tests pass |
| `plugin-inbox` | 🟥 stub | 6 ops `not_implemented`; real ~9k LOC in PA `inbox/` + `lifeops/email-*` |
| `plugin-finances` | 🟥 stub | "not yet wired"; real ~5.6k LOC in PA `lifeops/service-mixin-{payments,subscriptions}` etc. |
| `plugin-blocker` | 🟥 stub | engines still in PA `website-blocker/` (3.9k) + `app-blocker/` |
| `plugin-goals` | 🟥 stub | real in PA `service-mixin-goals.ts` (1.5k) |
| `plugin-todos` | 🟥 stub | real in PA reminders/owner-surfaces |
| `plugin-documents` | 🟧 partial | routes real (1.4k); action still stub; logic in PA `document-review.ts` |
| `plugin-relationships` | 🟥 stub, no UI | graph still in PA `lifeops/entities` + `relationships` |
| `plugin-remote-desktop` | 🟥 stub, no UI | real in PA `lifeops/remote-desktop.ts` |

**Stays in the PA hub (do NOT extract):** scheduled-task spine, registries,
channels, connector registry, send-policy, first-run, global-pause, handoff,
pending-prompts, owner orchestration (`actions/life.ts`), default-pack
composition.

**Open owner decision:** the entity/relationship graph (`lifeops/entities`,
`relationships`, `context-graph.ts`, `identity-observations.ts`, ~6k LOC) — hub
primitive (README's framing) vs `plugin-relationships`. Deepest inbound coupling;
decide before moving. *Deferred — not on the critical path for early slices.*

## The cross-cutting blocker

`lifeops/repository.ts` (8.9k LOC, ~328 methods) + `lifeops/schema.ts`
(`pgSchema("app_lifeops")`, ~65 tables) are the shared data layer for ALL
domains. Stubs declare empty parallel schemas (`app_inbox`, `app_finances`, …)
that no data flows into. **A domain cannot be filled until its tables + queries
are carved out of the monolith.** Slices are therefore ordered to defer the
heaviest schema splits.

## Testing reality

- Broad full-stack e2e/journey coverage exists (PA: 28 e2e + 12 live + 5 real;
  `packages/app/test/ui-smoke/` carries reminder/inbox/health/calendar journeys).
- **Missing entirely:** the recorded+live external-API contract pattern that
  `plugin-wallet` / `plugin-calendly` established (`*.recorded.json` replayed by a
  `*.contract.test.ts` + a `*.real.test.ts` for drift). Zero such fixtures in the
  LifeOps family.
- Largest logic modules untested: `repository.ts`, `service-mixin-reminders.ts`
  (5.4k), `email-curation.ts` (security-sensitive).
- Health connectors (Strava/Fitbit/Oura/Withings) parse no realistic payloads.

## Views + floating-chat reality

- Only `plugin-task-coordinator` ships a real, fully agent-wired view.
- 9/10 LifeOps views are empty placeholder shells (no data fetch).
- No loading/error/permission/connected states on any LifeOps view.
- 7 views not instrumented for the agent surface (`useAgentElement`) and not in
  `view-action-affinity.ts` `VIEW_ACTION_MAP` → floating chat can only DOM-scrape.
- Calendar instrumentation is dormant (`CalendarSection`/`EventEditorDrawer` call
  `useAgentElement` but `CalendarView.tsx` doesn't mount them).
- Screenshot harness EXISTS: `packages/app/test/ui-smoke/plugin-views-visual.spec.ts`
  (62 `VIEW_CASES`, PNG + `.audit.json`), ratcheted by `route-coverage.test.ts` +
  `view-interaction-coverage.test.ts`. Output is gitignored — no committed
  contact-sheet / manual-review like the cloud-frontend `audit:cloud` loop.

## Platform reality

- Mobile app/website blockers have real Swift/Kotlin but are **never registered**
  into the engine → `BLOCK` is a no-op on iOS/Android (P0 bug).
- No `@capacitor/local-notifications` → scheduled tasks can't surface an OS banner
  on mobile (P0).
- macOS calendar/reminders + Apple-Health depend on out-of-tree binaries
  (`libMacWindowEffects.dylib`, `ELIZA_HEALTHKIT_CLI_PATH`) — source not in repo.
- e2e: web runs on PR; desktop/android/ios authored but nightly/manual/release.

## Definition of done for ONE domain ("vertical slice")

1. Real implementation moved PA → focused plugin (no `not_implemented`).
2. Domain tables + queries carved out of the monolith into the plugin's own
   repository/schema; PA delegates via the plugin's public exports (facade), per
   the calendar/health reference.
3. View fetches its own data and implements every state: empty / loading /
   populated / error / permission-needed / connected-vs-disconnected.
4. Agent-surface instrumentation (`useAgentElement`) + `VIEW_ACTION_MAP` entry →
   floating-chat control.
5. Tests: unit + recorded mock-API contract + live `*.real.test.ts` + view render
   + ui-smoke visual case (PNG of each state) + an e2e journey.
6. Platform wiring verified for web/linux/mac/windows/ios/android (real-native or
   documented fallback), with the relevant native bridge registered.
7. `bun run verify` + scoped tests green.

## Execution order (lowest-risk-first, builds a repeatable template)

1. **plugin-blocker** — FIRST. Low DB coupling (engine = hosts-file/SelfControl +
   scheduled-task expiry), self-contained, and fixes the P0 mobile no-op by wiring
   `@elizaos/capacitor-appblocker` / `capacitor-websiteblocker`. Proves the full
   slice template end-to-end on a low-risk domain.
2. **plugin-remote-desktop** — tiny, low coupling (desktop-host only).
3. **plugin-finances** — self-contained ~5.6k; first real schema carve-out.
4. **plugin-documents** — routes already real; finish the action.
5. **plugin-inbox** — largest/most-coupled; do once template proven.
6. **plugin-goals / plugin-todos** — reminders fused with the spine; untangle last.
7. **Entity-graph decision** (hub vs plugin-relationships), then act.
8. Cross-cutting: split `repository.ts`/`schema.ts` incrementally per slice;
   add the recorded+live contract harness; commit a LifeOps view screenshot/
   manual-review loop; get android `_android` + an iOS sim smoke onto a CI lane.

## Progress log

- 2026-06-17: Four-dimension audit complete (decomposition / tests / views /
  platform). Plan written. Starting slice 1 (plugin-blocker).
