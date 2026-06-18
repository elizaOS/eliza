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

### TWO foundational prerequisites gating further extraction (discovered 2026-06-17)
The slice-1 template moved *services/engines/providers* cleanly. Moving the rest
hits two cross-cutting prerequisites that must be tackled deliberately FIRST:

1. **Shared action-resolution + LLM-extraction layer** — gates moving ANY domain
   *action* out of PA. `actions/lib/resolve-action-args.ts` (`resolveActionArgs`,
   423 LOC, used by 10 PA actions) depends on `lifeops/llm/extractor-pipeline.ts`
   + `utils/json-model-output.ts` + `actions/lib/recent-context.ts`. Until this
   stack is promoted to a shared package (likely `@elizaos/agent` — has LLM
   access, all plugins depend on it), domain actions (remote-desktop, finances,
   inbox, goals, todos) cannot move. This is why slice 1 left the BLOCK action in
   PA. **De-risked 2026-06-17:** the whole stack is CLEAN — `resolve-action-args.ts`
   (423), `lifeops/llm/extractor-pipeline.ts` (113, imports only core), `actions/
   lib/recent-context.ts` (core + `getRecentMessagesData` from shared), `utils/
   json-model-output.ts` (pure) depend ONLY on `@elizaos/core` + `@elizaos/shared`.
   Ideal home: **`@elizaos/core/actions/`** next to the sibling
   `promoteSubactionsToActions` (every plugin deps core; core already imports
   shared, so `getRecentMessagesData` resolves). Then rewire the 10 PA importers
   (app-block, autofill, calendar, lib/index, life, remote-desktop, resolve-request,
   screen-time, voice-call, website-block) + future domain plugins to
   `@elizaos/core`. CAUTION: this modifies `@elizaos/core` — the innermost package
   every concurrent actor depends on; a transient break disrupts the whole shared
   develop tree. Do it COORDINATED / when not sharing the tree, with a full core +
   PA + one-domain-plugin build verify.
2a. **Finances carve-out (owner picked: migrate to `app_finances` w/ data migration) —
   de-risked 2026-06-17, but high-stakes.** The 5 real finance tables live in
   `lifeops/schema.ts`: `lifeSubscriptionAudits` (311), `lifeSubscriptionCandidates`
   (330), `lifeSubscriptionCancellations` (353), `lifePaymentSources` (401),
   `lifePaymentTransactions` (419), re-exported via the schema barrel ~1810. The
   `plugin-finances` stub schema declares a DIFFERENT design (`transactions` table,
   never populated) — so the carve-out must (a) adopt PA's real table defs verbatim
   under `pgSchema("app_finances")` (replacing the unused stub design), (b) PA
   import them from `@elizaos/plugin-finances` (add dep; no cycle), and (c) ship a
   DATA MIGRATION copying existing `app_lifeops.life_{payment_*,subscription_*}`
   rows → `app_finances.*`, wired into the schema-bootstrap path (the bootstrap
   method in `repository.ts`). The data migration is the risky part (data-loss
   potential) — must be done as a dedicated, deeply-verified slice + owner review,
   NOT rushed. Then extract the 139 finance repo methods + 4.7k mixin LOC + the
   OWNER_FINANCES action (now unblocked — resolveActionArgs is in core) + real
   FinancesView. The schema rename + data migration MUST land together (renaming
   alone orphans existing data).

2. **`app_lifeops` schema carve-out** — gates filling inbox/finances/goals/todos
   (their data is in the monolith). Schema is `appLifeopsPgSchema.table(...)` in
   `lifeops/schema.ts` (40+ tables). Finance owns `lifePaymentSources`,
   `lifePaymentTransactions`, `lifeSubscription{Audits,Candidates,Cancellations}`.
   repository.ts (8.9k LOC) has 139 finance refs interwoven w/ other domains +
   shared `executeRawSql` helpers. **Owner decision:** keep the `app_lifeops`
   schema name (table defs live in the plugin, no data migration) vs move to
   `app_finances` (clean ownership, needs a data migration for existing installs).

remote-desktop specifics: engine (`lifeops/remote-desktop.ts`) + `remote/`
(remote-session-service + pairing-code, remote-desktop-specific) are clean; the
action is blocked on prerequisite #1.

### Next domains (after the two prerequisites, sequentially — each edits PA)
finances (schema carve-out) → documents (routes already real) → inbox (largest)
→ goals/todos (reminders fused w/ spine) → remote-desktop.

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

### Session 2026-06-17 (round 2) — 5 more commits, pushed
Owner asked to pursue all streams in parallel + migrate finances to `app_finances`
+ push. Shipped + pushed:
- `ffbc46596f` action-resolution stack → `@elizaos/core/actions/` (prereq #1 DONE
  — unblocks all domain action extractions; core does NOT dep shared, so the
  recent-messages accessor was inlined; also fixed app-block.test stale mock).
- `9e14ddbe03` mobile native blocking backends (P0): adapters + registrars +
  WebView-startup registration. RESIDUAL: agent-process engine needs an
  agent→WebView channel (task #15).
- `29b1a0bc88` Fitbit/Withings/Google-Calendar recorded+live contract tests.
- `0888ee938b` real FinancesView over /api/lifeops/money/* + VIEW_ACTION_MAP
  finances→OWNER_FINANCES. (Finances SCHEMA carve-out + data migration is still
  the dedicated remaining effort — view shipped safely without touching schema.)

Net across the day: **4 production-grade decomposed views** (blocker/health/
calendar/finances) w/ all states + floating-chat; the core action-resolution
unblock; platform P0 wiring; recorded+live contract tests for 5 connectors. All
pushed to origin/develop.

### Session 2026-06-17 (round 3) — view sweep complete + pushed
Built the remaining safely-buildable decomposed views (each fetches an EXISTING
PA route, all states + agent-surface + VIEW_ACTION_MAP + ui-smoke mock, no schema
risk, no PA import): `0888ee938b` finances, DocumentsView, `65cc9e32aa` inbox,
`df02505487` goals. **7 production-grade decomposed views total** now:
blocker(focus)/health/calendar/finances/documents/inbox/goals.
VIEW_ACTION_MAP: calendar/health/focus/finances/inbox/goals wired (documents
SKIPPED — OWNER_DOCUMENTS is const-derived, would fail the drift guard).

**TodosView is BLOCKED** — there is no `/api/lifeops/todos` list route (reminders
routes are acknowledge/inspection/process only), so todos can't fetch real data
until its data layer extracts. relationships/remote-desktop have no UI by design.

So the VIEW dimension is essentially done for everything that has a data source;
what remains is the back-end extraction (schema carve-out + repo/services/action
moves), which unblocks todos' view and makes the others' data plugin-owned.

### Session 2026-06-17/18 (round 4) — finances schema carve-out + view sweep complete
- `1cdfe95249` **finances app_finances schema carve-out** (the first carve-out;
  proven pattern): moved the 5 finance table defs PA→plugin-finances on
  `pgSchema("app_finances")`, removed from PA's lifeOpsSchema registration,
  repointed all 20 raw finance SQL refs in repository.ts via a `FINANCE_SCHEMA`
  const (completeness gate `rg app_lifeops.life_(payment|subscription)` = empty),
  wired plugin-finances to load with PA + OPTIONAL_CORE_PLUGINS, and added a
  NON-DESTRUCTIVE idempotent `FinancesMigrationService` (per table: copy
  app_lifeops.*→app_finances.* only if source exists via to_regclass AND target
  empty; never drops source; 17 tests).
- `683f63011f` **TodosView real** via a new thin `GET /api/lifeops/todos` route
  (reuses `getOverview`; the task tables are SHARED SPINE, stay in the hub — todos
  is a projection, NOT a carve-out). **All 8 decomposable views now production-grade.**

KEY PATTERN LEARNINGS:
- Movable-schema domain (finances): tables are domain-specific → carve out to the
  plugin's pgSchema + non-destructive data migration + repoint raw SQL refs.
- Spine-backed domain (todos): tables (`life_task_*`) are shared scheduled-task
  infra → DO NOT move; expose a thin read route and project.
- Every carve-out: completeness grep gate + plugin-must-not-import-PA + the
  movable plugin must be LOADED (PA init ensure + OPTIONAL_CORE_PLUGINS) so its
  schema gets created.

### Session 2026-06-18 (round 5) — finances FULLY decomposed (back-end)
`d9d226f914` extracted the payments back-end PA→plugin-finances: a standalone
`FinancesService` (was the `withPayments` mixin) + `FinancesRepository` (over
app_finances) + the finance helpers/types + the `OWNER_FINANCES` payments handler.
PA delegates — `LifeOpsService` drops `withPayments`; `LifeOpsRepository`'s 19
finance methods are one-line delegations to `FinancesRepository`; the
`/api/lifeops/money/*` routes use `runFinancesRoute → FinancesService` (URLs +
shapes unchanged). **Finances is now fully decomposed** (schema + data + repo +
service + action + routes + view + tests). Gates: no PA import; plugin-finances
17/17; PA build:types exit 0 (strict tsc DOWN 33, zero new); PA suite 611 pass.

DELIBERATE BOUNDARY (documented in plugin-finances/CLAUDE.md): the
`withSubscriptions` mixin STAYS in PA — it orchestrates Gmail triage + browser
bridge + computer-use + PA's `app_lifeops.life_workflow_browser_sessions`, so it
can't be a PA-import-free service. It reaches finance tables via
`LifeOpsRepository → FinancesRepository`. This is the model for inbox/goals: move
the movable, leave spine/cross-domain-orchestration in PA behind delegation.

Remaining back-end: goals (service-mixin-goals 1.5k + lifeGoal* tables — tractable,
next) and inbox (~9k, gmail/triage/curation — largest, entangled w/ connectors +
approval-queue). Same proven pattern + the partial-extraction discipline.

### Session 2026-06-18 (rounds 6-7) — inbox + goals back-ends migrated
- `d33e9ed042` **inbox triage back-end** → plugin-inbox: INBOX action +
  InboxService + InboxRepository + inboxTriage provider + domain modules; 40 tests.
  Repo schema decision (a): keep `app_lifeops.life_inbox_triage_entries` (PA
  getInbox spine co-owns it). DELEGATED (stays in PA): service-mixin-inbox.getInbox
  (backs the route/view), gmail/email-curation/bulk-review/cross-channel-search.
- `b9698f8675` **goal CRUD back-end** → plugin-goals: GoalsService + GoalsRepository
  + real OWNER_GOALS action; 23 tests. Schema (a) shared (reminders read life_goal_*).
  DELEGATED: reminder-plan coupling + cross-domain goal review/overview + audit/
  ownership (injected hooks).

DECOMPOSITION STATUS: backends migrated for **finances (full), inbox (triage core),
goals (CRUD core)** + blocker engine + ALL 8 views. Each: focused plugin owns the
movable domain; PA delegates; connector/spine/cross-domain coupling stays in PA
behind a documented seam (the recurring, correct boundary).
Remaining: remote-desktop (small, low-coupling — next), relationships (entity graph
— OWNER DECISION), and the legitimately-hub reminders/scheduling spine. Plus the
delegated sub-backends (subscriptions, gmail-curation, goal-review, getInbox) which
need connector-contract seams first. 5-OS e2e remains environment-bounded.

### Session 2026-06-18 (rounds 8-9) — remote-desktop + relationships viewer
- `36306214d8` remote-desktop fully extracted (engine + session service + action →
  plugin-remote-desktop; no DB; 10 tests; PA delegates; no double-registration).
- `53b72911e1` RelationshipsView (the viewer) added to plugin-relationships per the
  owner decision (entities/relationships = runtime primitive; plugin holds the
  VIEWER + extras). 9th decomposed view; ENTITY → VIEW_ACTION_MAP; all ratchets wired.

### #20 (entities/relationships → runtime) — RESEARCHED 2026-06-18, confirmed LARGE
PA's lifeops `EntityStore`/`RelationshipStore`/`merge`/`context-graph` (~6k LOC over
app_lifeops tables) **DUPLICATES** the runtime's existing entity/relationship system:
`@elizaos/core` already has `Entity`/`Relationship`/`Component` types
(`types/environment.ts`) + `services/relationships.ts` (ContactInfo,
EntityIdentityRecord, MergeCandidateEvidence, identity-link/merge) +
`relationships-graph-builder.ts` (2.6k) + `@elizaos/agent` resolveRelationshipsGraphService.
So the owner directive = FOLD PA's parallel graph into core's entity system (not a
move to plugin-relationships). This is: core-types-touching + the DEEPEST inbound
coupling in the repo (connectors/checkin/followup/providers/default-packs/voice/
routes/repository/identity-observations) + a data migration (app_lifeops entities/
relationships → the runtime entity store) + reconciling two schemas/APIs.
=> Dedicated, coordinated, multi-step effort with full verification headroom on a
quiet tree — modifying @elizaos/core mid-session risks breaking all ~10 concurrent
actors. NOT a tail-of-session change. Suggested first slices: (1) map PA EntityStore
API ↔ core relationships service API gaps; (2) add any missing core service methods
(additive, low-risk); (3) strangler-fig PA writes onto the core service; (4) migrate
data; (5) rewire PA readers; (6) delete PA's parallel store.

### Environment-bounded (cannot complete in this sandbox; needs real-device CI + creds)
5-OS e2e (linux/ios/android/mac/windows) — web ui-smoke is PR-gated + green; desktop/
android/ios harnesses are authored but unrunnable here (no iOS sim; Android emulator
segfaults the embedded bun agent on stock x86_64 — needs real HW/Cuttlefish). Live
`*.real.test.ts` need real provider credentials. These are CI-on-real-devices tasks.

### Session 2026-06-18 (round 10) — view-state screenshot review (the "review by you")
Built a light headless-chromium screenshot harness
(`packages/app/test/view-screenshots/`, committed `49fe2f6001`; output gitignored)
that renders each of the 9 decomposed views in every state (vite + the same
@elizaos/ui stubs the jsdom tests use; no 20-min agent stack — runs in-sandbox).
Captured 76 PNGs (9 views × loading/error/empty/populated[+focus's unavailable/
permission/active] × desktop+mobile) and I VISUALLY REVIEWED a representative set
across all 9 views + error/permission/empty states + mobile.
**Outcome: production-grade.** Dark theme, orange-accent-ONLY (active toggles,
primary CTAs, unread/at-risk dots), NO blue anywhere, clean hierarchy, right-
aligned values, responsive mobile (chips wrap, previews truncate), error states
have orange Retry CTAs, permission/disconnected states are honest. Calendar event
chips render neutral-gray (the no-blue design pass holds).
Minor non-blocking nits (tracked, not fixes): (1) relationships kind-labels
(PEOPLE/ORGANIZATIONS) are slightly orange-heavy — acceptable accent-tag usage,
not a blue violation; (2) calendar event-chip text can clip vertically — a harness
Tailwind-shim artifact (full theme present in the real app), not a view bug.
Run: `node packages/app/test/view-screenshots/run.mjs`.

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
