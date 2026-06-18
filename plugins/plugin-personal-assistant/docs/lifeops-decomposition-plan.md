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

## Proven migration template (validated on plugin-blocker)

The calendar/health pattern, now re-validated end-to-end and reusable:

1. **Dependency direction:** focused plugin owns the impl and MUST NOT import
   `@elizaos/plugin-personal-assistant` (`rg plugin-personal-assistant
   plugins/<plugin>/src` must be empty). PA adds `"@elizaos/<plugin>":
   "workspace:*"` and re-exports the moved symbols for back-compat.
2. **Move the dependency-clean core first** (engine/service/access/providers —
   anything importing only node + `@elizaos/core`/`@capacitor/core`). Leave
   modules coupled to `lifeops/*` (e.g. `lifeops/sql`, `lifeops/defaults`) in PA
   for a later sub-slice; rewire them to import the moved code from the plugin.
3. **Registration handoff is per-surface and atomic** — to avoid double
   registration, move a whole surface (service/provider/action/view) or none.
   Partial is OK across surfaces (e.g. services+providers move, action stays) as
   long as exactly one plugin registers each.
4. **Preserve exact runtime string values** (serviceType, action/provider
   `name`, task-name consts) — runtime lookups depend on them.
5. **Real view:** fetch from the plugin's HTTP route via `client.getBaseUrl()`
   with an injectable fetcher seam for offline jsdom tests; render all states
   (loading/error/unavailable/permission/empty/active) each with a `data-testid`;
   instrument primary controls with `useAgentElement` from `@elizaos/ui/agent-surface`
   (extract child components — hooks can't run in `.map()`). That alone wires the
   floating chat (generic list-elements/agent-click capabilities). `VIEW_ACTION_MAP`
   in `packages/agent/src/runtime/view-action-affinity.ts` is an optional planner
   refinement — only add names that exist as literal `name: "X"` (a git-grep drift
   test in `view-action-affinity.test.ts` enforces this; promoted/const-derived
   names like `BLOCK_*` will fail it).
6. **Verify gates:** plugin typecheck + test + `build:views`; PA `build:types`;
   dependency-rule grep; no dangling imports to moved files.

### Shared working-tree hazard (critical)
`develop` is edited by multiple concurrent actors. Files appear/disappear from
`git status` between commands. NEVER `git add -A`. Stage only your slice's files
by explicit path. Confirm `git diff --cached --name-only` has no foreign churn
before committing.

## Progress log

- 2026-06-17: Four-dimension audit complete (decomposition / tests / views /
  platform). Plan written.
- 2026-06-17: **Slice 1a DONE + committed** (`99b8866199`) — extracted
  website/app block engine + services + providers from PA into `plugin-blocker`.
  plugin-blocker typecheck+build+test green (7/7); PA blocker tests 22/22; PA
  build:types green; dependency rule clean.
- 2026-06-17: **Slice 1b DONE + committed** (`9436f31bab`) — real `FocusView`
  over GET /api/website-blocker with all 6 states + `useAgentElement` controls;
  12 render tests green; design-compliant (orange-only). Floating-chat control
  achieved via agent-surface generic capabilities.

### Remaining for slice 1 (plugin-blocker) to be fully "production grade"
- BLOCK action + chat-integration persistence port (raw `lifeops/sql` →
  `app_blocker` drizzle schema), then move the action to plugin-blocker.
- P0 native wiring: register a `NativeWebsiteBlockerBackend` adapter (wrapping
  `@elizaos/capacitor-websiteblocker`) at mobile webview startup
  (`packages/app/src/main.tsx` `initializePlatform`) — FIRST verify the agent
  engine instance is in the same JS context as the webview on mobile, else the
  registration won't reach it. App-blocker needs a registrar (none exists) + an
  `/api/app-blocker` status route for the view's app section.
- `VIEW_ACTION_MAP["focus"]` once a literal-named blocker action exists.
- Strengthen ui-smoke: per-state visual cases (active/permission/error) via the
  interaction-spec `page.route` override pattern.

- 2026-06-17: **Slice 2 DONE + committed** (`725c650169`) — recorded+live
  contract tests for Strava + Oura health connectors (the repo's gold-standard
  external-API pattern; was the #1 test gap). Fixtures + offline contract tests
  asserting raw→normalized transforms + gated live drift tests. plugin-health
  60→62 tests; no production code changed.
- 2026-06-17: **Slice 3 DONE + committed** (`0a40544a37`) — real `HealthView`
  over /api/lifeops/sleep/{history,regularity,baseline}, all states +
  `useAgentElement`; 7 render tests; ui-smoke sleep mocks fixed. plugin-health
  63 tests. Pairs with slice 2.

### CalendarView (deferred — NOT a clean mount)
`CalendarSection.tsx` is the rich, already-instrumented component but mounting it
in the stub `CalendarView.tsx` needs: (a) 4 host-shell props (selectedEventId/
onSelectEvent/onChatAboutEvent/getPrimedEvent) + `useApp()`/AppProvider context
inside the view bundle, and (b) a DESIGN PASS — it uses Tailwind
`bg-blue-500`/`violet`/`emerald` event-category colors that violate the no-blue
rule. Treat as a full view slice, not a wiring fix.

### Next domains (replicate template, sequentially — each edits PA)
remote-desktop (tiny, safest) → finances (first schema carve-out) → documents
(routes already real) → inbox (largest) → goals/todos (reminders fused w/ spine).

- 2026-06-17: **Slice 4 DONE + committed** (`1b1848cd8a`) — real `CalendarView`
  mounts the rich, instrumented `CalendarSection` (floating chat now drives the
  calendar) + no-blue design pass. Found+fixed a real bug: the event-color
  Tailwind classes never compiled (plugin-calendar/src not in any `@source`).
  plugin-calendar 73 tests; build:views green.
- 2026-06-17: **VIEW_ACTION_MAP** (`507056fd77`) — planner affinity for the now-
  real calendar/health/focus views (CALENDAR / OWNER_HEALTH+OWNER_SCREENTIME /
  LIST_ACTIVE_BLOCKS+RELEASE_BLOCK). Drift guard: 51 pass.

### Session 2026-06-17 net: 8 commits — audit+plan, blocker extraction (1a),
FocusView (1b), health contract tests (2), HealthView (3), CalendarView (4),
VIEW_ACTION_MAP. Three of four dimensions proven end-to-end on REAL domains:
decomposition (blocker), production-grade views w/ all states + floating-chat
(blocker/health/calendar), mock+live external-API contract tests (health). The
4th — platform (5-platform e2e + the mobile-BLOCK P0) — is the least-advanced;
documented above, blocked on the engine-process-instance architecture check.

### Genuine owner decisions to resolve before the next big slices
1. Entity/relationship graph: hub primitive vs `plugin-relationships`.
2. Mobile blocking P0: agent-side `NativeWebsiteBlockerBackend` that proxies to
   the webview Capacitor plugin, vs registering in the webview (engine instance
   lives in the agent process, not the webview).
3. Reminders cross-platform: DB-only-everywhere (fix docs) vs per-platform
   mirrors / Google Tasks fallback.
4. Next priority: breadth (finances/inbox/remote-desktop extractions + the
   `app_lifeops` schema carve-out) vs depth (5-platform e2e + committed
   screenshot/design-review loop for the 3 real views).

NOTE: all commits are on LOCAL develop (shared tree, many concurrent actors,
incl. an origin/develop merge mid-session) — NOT pushed; pushing needs
coordination given the churning dirty tree.
