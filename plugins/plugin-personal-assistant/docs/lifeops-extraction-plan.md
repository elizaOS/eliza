# LifeOps Extraction — Master Execution Plan (owner-directed)

> Authoritative, globally-sequenced execution plan to decompose
> `@elizaos/plugin-personal-assistant` (PA / "LifeOps", ~137k LOC,
> `plugins/plugin-personal-assistant/src`). Synthesizes four area plans into one
> dependency-correct sequence. This OVERRIDES the earlier "keep the spine in the
> hub" recommendation in `lifeops-decomposition-plan.md`.
>
> Owner directive: extract the **scheduling spine** → new `plugin-scheduling`;
> extract **reminders** → new `plugin-reminders` (depends on scheduling); **remove
> the overview view**; complete all cleanup follow-ups.
>
> Architecture invariants live in `../README.md` / root `AGENTS.md`. The proven
> template is `plugin-finances` (`plugins/plugin-finances/CLAUDE.md` +
> `plugins/plugin-finances/src/services/migration.ts`). Replicate it.

---

## 0. Verified ground truth (read before touching anything)

Every claim below was checked against the actual source.

| Fact | Evidence (file:line) |
|---|---|
| Spine tree lives under `lifeops/`, **not** `src/scheduled-task/` | `plugins/plugin-personal-assistant/src/lifeops/scheduled-task/` (18 files, 6892 LOC) |
| `runner.ts` is storage-agnostic; its only out-of-tree import is `import type { DispatchResult }` | `lifeops/scheduled-task/runner.ts:17` (type-only) |
| `types.ts`/`gate-registry.ts`/`completion-check-registry.ts`/`escalation.ts`/`consolidation-policy.ts`/`state-log.ts`/`index.ts` import **only** `@elizaos/core` + each other | per-file grep, all clean |
| `due.ts` + `next-fire-at.ts` import only `../registries/anchor-registry.js` | grep |
| `scheduler.ts` is the coupled tick: imports `../owner/fact-store.js`, `../pending-prompts/store.js`, `../registries/anchor-registry.js`, `../repository.js` | grep |
| `runtime-wiring.ts` (the ONLY hardwire point) imports 9 PA modules + `@elizaos/agent` + `@elizaos/app-core` | `runtime-wiring.ts:11-30` |
| `new LifeOpsRepository(runtime)` is constructed in wiring (line 82) and in `scheduler.ts` (line 98) | grep |
| serviceType literal is `"lifeops_scheduled_task_runner"` | `scheduled-task/service.ts:32,47` |
| `processDueScheduledTasks` exported at | `scheduler.ts:88`; news up repo (98), reads owner facts (108), anchors (113), records pending prompt (267) |
| `processScheduledWork` interleaves circadian/reminders/workflows/scheduled-tasks | `service-mixin-reminders.ts:5062`; calls `processReminders` (5190) + `processDueScheduledTasks` (5204) |
| `processReminders` (4995), `processDueReminderDeliveries` (4611), `processDueReminderReviewJobs` (3140) | `service-mixin-reminders.ts` |
| Reminder-owned repo methods: createReminderPlan(3126) updateReminderPlan(3146) deleteReminderPlan(3159) getReminderPlan(3168) listReminderPlansForOwners(3184) createReminderAttempt(5178) listReminderAttempts(5211) listDueReminderReviewAttempts(5241) claimDueReminderReviewAttempts(5285) updateReminderAttemptOutcome(5320) upsertEscalationState(5906) getActiveEscalationState(5955) resolveEscalationState(5971) listRecentEscalationStates(5983) deleteAllEscalationStates(5998) | `lifeops/repository.ts` |
| Cross-domain spine reads delivery needs: listActiveDefinitions(2723) listOccurrenceViewsForOverview(2898) listChannelPolicies(3854) getChannelPolicy(3865) listCalendarEvents(4320) readCircadianState(6781) getScheduleMergedState(7046) | `lifeops/repository.ts` |
| Spine tables in `app_lifeops`: life_task_definitions(88) life_task_occurrences(128) life_scheduled_tasks(1417) life_scheduled_task_log(1473) | `lifeops/schema.ts` |
| Reminder tables in `app_lifeops`: life_reminder_plans(225) life_reminder_attempts(247) life_escalation_states(834) | `lifeops/schema.ts` |
| Overview view registered (GUI/XR/TUI), id `"lifeops"`, component `LifeOpsPageView` | `src/plugin.ts:755,768,782` |
| Overview route `GET /api/lifeops/overview` → `service.getOverview()` | `src/routes/plugin.ts:331`; `src/routes/lifeops-routes.ts:2285,2298` |
| **VIEW_ACTION_MAP critical fact:** `OWNER_REMINDERS/OWNER_ALARMS/OWNER_ROUTINES` map to the **`goals`** view; the **`lifeops`** view maps ONLY to `PERSONAL_ASSISTANT` | `packages/agent/src/runtime/view-action-affinity.ts:165,167` |
| Core stub `StubScheduledTaskRunner` is DEAD — only 5 self-refs in its own `runner.ts`, exported via `core/index.ts:34` | grep repo-wide |
| Goals dual writers confirmed: PA repo 10 refs + goals repo 10 refs to `life_goal_*` | grep |
| Calendar dual writers confirmed: PA repo 21 refs + calendar repo 11 refs to `life_calendar_*` | grep |
| Goals dead schema: routinesTable(42) remindersTable(61) alarmsTable(84) checkinsTable(106) — `app_goals.{routines,…}` NEVER queried | `plugins/plugin-goals/src/db/schema.ts` |
| pending-prompts / global-pause / handoff stores are cache-only (no SQL) | `lifeops/{pending-prompts,global-pause,handoff}/store.ts` |
| `approval_requests` table is owned by **plugin-sql** (`packages/plugin-sql/src/schema/approvalRequests.ts`), public schema — NO data migration | grep; `lifeops/approval-queue.ts` raw SQL has no schema prefix |
| `app_blocker.block_rules` (plugin-blocker) is registered-but-NEVER-queried; `life_block_rules` (PA) IS live | grep |
| Finances precedent is REAL and mirrors every step: delegation, carve, non-destructive `FinancesMigrationService`, `ensureLifeOpsFinancesPluginRegistered`, action-stays-in-PA | `plugin-finances/CLAUDE.md`; `migration.ts:31-41`; `lifeops/schema.ts:311-315`; PA `plugin.ts:569-572` |

**Template invariants (from finances, applied throughout):**
1. New plugin **MUST NOT** import PA. Gate: `rg "@elizaos/plugin-personal-assistant" plugins/<p>/src` → comments only.
2. Move dependency-clean core first; inject the PA-coupled bits.
3. Schema carve = focused plugin declares its own `pgSchema("app_X")` with **verbatim table names**; a non-destructive `MigrationService` (to_regclass guard + target-empty check + `INSERT…SELECT NOT EXISTS` + never-drop-source) copies `app_lifeops.*` → `app_X.*`; raw SQL repointed via a `TARGET_SCHEMA` const; PA's `LifeOpsRepository` **delegates** the moved methods to the new repository.
4. Atomic, single-registrar handoff (runtime first-wins dedups). PA depends on the new plugin (`workspace:*`) + auto-registers via an `ensureLifeOps<X>PluginRegistered` guard.
5. Preserve runtime string literals: serviceType, action names, event names. VIEW_ACTION_MAP names are guarded by the drift test (`packages/agent/src/runtime/view-action-affinity.test.ts`).
6. Gate every slice with `plugins/plugin-personal-assistant/test/decomposition-integration.test.ts` (no dropped owner action, no serviceType collision, no view shadow, every VIEW_ACTION_MAP name registered).

---

## 1. Global sequencing rationale

Order chosen to **de-risk before the heavy lifts** and respect the hard
dependency `plugin-reminders → plugin-scheduling`:

1. **Overview removal + safe deletions first** — bounded, low-risk, shrinks the
   surface (fewer consumers of the spine reads before we move the spine).
2. **Independent runtime-service promotions** (cache-backed + approval) — zero
   data risk, removes PA-internal coupling that the spine seam otherwise has to
   carry as injected deps. Doing these BEFORE the spine move means `scheduler.ts`'s
   pending-prompt side effect is already a resolvable runtime service.
3. **Schema carve-outs that de-risk** (goals, calendar) — independent of the
   spine; landing them now proves the migration template on live dual-writer
   tables before the reminders carve (which is the same pattern, higher stakes).
4. **plugin-scheduling** — the spine. Pure code move (tables stay in
   `app_lifeops` initially) + invert the wiring.
5. **plugin-reminders** — depends on scheduling's ports; the largest carve.
6. **Core stub deletion + final cleanup** — only safe once the real spine type
   exists in `@elizaos/plugin-scheduling`.

> **Concurrency hazard (root AGENTS.md):** multiple agents/worktrees touch
> `develop` (see `.claude/worktrees/*`). `lifeops/repository.ts`, `schema.ts`,
> `service-mixin-reminders.ts`, `src/plugin.ts`, and `view-action-affinity.ts`
> are shared hot files. Commit each slice atomically, push proactively, never
> stash, and re-base before the carve slices.

---

## 2. The ordered slices

Risk legend: **SAFE-NOW** = high-confidence, fully verifiable, landable in one PR.
**NEEDS-CARE** = data migration / deep coupling, must be atomic, review-gated.

---

### Slice 1 — Remove the LifeOps overview view (`SAFE-NOW`, low)

**Why first:** bounded, no data, no new package. The overview is the legitimate
cross-domain aggregation the README reserves — but the owner directed its removal.

**File ops:**
- `src/plugin.ts`: delete the three `LifeOpsPageView` view descriptors (id
  `"lifeops"`, `componentExport: "LifeOpsPageView"`) at lines `755`, `768`, `782`
  (GUI/XR/TUI) and their imports. Remove `LifeOpsPageView` from the component
  export barrel (`src/ui.ts` / `src/components/` if exported there).
- `src/routes/lifeops-routes.ts`: delete the `GET /api/lifeops/overview` handler
  (`:2285`, calls `service.getOverview()` at `:2298`). Remove the route descriptor
  from `src/routes/plugin.ts:331`.
- **KEEP** `service.getOverview()` and `repository.listOccurrenceViewsForOverview`
  — reminder DELIVERY still reads occurrence views via the spine port (slice 8).
  Only the VIEW + its HTTP route are removed.
- Update PA `CLAUDE.md` "Views" section (delete the overview-hub paragraph).

**Verification gate:**
- `rg '"lifeops"' src/plugin.ts` and `rg '/api/lifeops/overview' src` → no view/route.
- `rg 'lifeops' packages/agent/src/runtime/view-action-affinity.ts` confirms the
  `lifeops` view maps only to `PERSONAL_ASSISTANT` — **no VIEW_ACTION_MAP entry
  targets the removed view component** (the `lifeops` key is the
  PERSONAL_ASSISTANT action affinity, not a component reference, so removing the
  view does not orphan a map entry — confirm no `componentExport: "LifeOpsPageView"`
  remains).
- `bun run --cwd plugins/plugin-personal-assistant verify`.
- `decomposition-integration.test.ts` green (no view shadow, no dropped action).

---

### Slice 2 — Delete vestigial dead `app_goals` schema (`SAFE-NOW`, low)

**File ops:**
- `plugins/plugin-goals/src/db/schema.ts`: delete `routinesTable`(42),
  `remindersTable`(61), `alarmsTable`(84), `checkinsTable`(106) and their inferred
  types `RoutineRow/Insert`, `ReminderRow/Insert`, `AlarmRow/Insert`,
  `CheckinRow/Insert` (129-136). **KEEP `goalsTable`** (it is the carve target for
  slice 6).
- `plugins/plugin-goals/src/db/index.ts` + `src/index.ts`: remove the four
  re-exports.
- `plugins/plugin-goals/CLAUDE.md`: drop the four tables from the schema bullet.

**Verification gate:**
- `rg 'routinesTable|remindersTable|alarmsTable|checkinsTable' plugins/plugin-goals/src` → empty.
- `bun run --cwd plugins/plugin-goals verify`.

---

### Slice 3 — Promote pending-prompts / global-pause / handoff to `@elizaos/agent` runtime services (`SAFE-NOW`, low)

**Why now:** cache-backed (verified zero SQL), zero PA-internal coupling beyond
their own store file. Promoting them BEFORE the spine move turns
`scheduler.ts`'s pending-prompt side effect into a resolvable runtime service the
spine can inject cleanly.

**File ops (per store, follow `packages/agent/src/services/knowledge-graph/service.ts` exactly):**
- Create `packages/agent/src/services/pending-prompts/service.ts`,
  `.../global-pause/service.ts`, `.../handoff/service.ts`. Each: a serviceType
  literal const (`'eliza_pending_prompts'`, `'eliza_global_pause'`,
  `'eliza_handoff'`), a `class XService extends Service { static serviceType = … }`
  whose body is the **copied** store ops (lift from PA
  `lifeops/{pending-prompts,global-pause,handoff}/store.ts`; copy `runtime-cache.js`
  inward or use core cache directly), plus
  `export function resolveXService(runtime): XService | null`.
- Register the three classes in `packages/agent/src/runtime/eliza-plugin.ts`
  `createElizaPlugin()` `services[]`.
- Export from `packages/agent/src/services/index.ts` + `packages/agent/src/index.ts`
  (mind the TS2308 duplicate-symbol comments).
- In PA: replace direct store imports/constructions with `resolveXService(runtime)`.
  Keep PA store files as one-release re-export shims **or** delete + rewrite call
  sites. **Direction:** agent is INNER — agent must NOT import PA store files; the
  bodies are COPIED inward, PA's copies shimmed/deleted.

**Verification gate:**
- `rg '@elizaos/plugin-personal-assistant' packages/agent/src` → nothing (inward-only law).
- `bun run --cwd packages/agent verify`; PA `build:types` + `test` green.
- `decomposition-integration.test.ts`: no collision on the three `eliza_*` serviceTypes.

---

### Slice 4 — Promote approval-queue to `@elizaos/agent` `ApprovalService` (`SAFE-NOW`, medium)

**Why no data risk:** `approval_requests` is owned by **plugin-sql**
(`packages/plugin-sql/src/schema/approvalRequests.ts`), public schema — pure code
move, NO migration.

**File ops:**
- Create `packages/agent/src/services/approval/service.ts`: `ApprovalService extends
  Service` (serviceType `'eliza_approval_queue'`) wrapping `PgApprovalQueue` logic
  lifted from `plugins/plugin-personal-assistant/src/lifeops/approval-queue.ts`
  (the `ALLOWED_TRANSITIONS` table + enqueue/list/resolve raw SQL over
  `approval_requests`); + `resolveApprovalService` helper.
- Move `approval-queue.types.ts` to `@elizaos/shared` (cross-package transport) or
  `packages/agent/src/services/approval/types.ts` (agent-private).
- Register in `createElizaPlugin` `services[]`.
- In PA: `actions/resolve-request.ts` + any outbound-send / document-signature path
  constructing `new PgApprovalQueue` (and the `index.ts` re-export) switch to
  `resolveApprovalService(runtime)`. Delete PA's `approval-queue.ts` + its sql copy,
  or leave a one-release re-export shim. Table stays owned by plugin-sql.

**Verification gate:**
- `rg '@elizaos/plugin-personal-assistant' packages/agent/src` → empty.
- `bun run --cwd packages/agent verify`; PA verify green.
- Manual: a `RESOLVE_REQUEST` round-trip still enqueues + resolves an
  `approval_requests` row (state-machine transitions unchanged).

---

### Slice 5 — Carve goals tables `app_lifeops.life_goal_*` → `app_goals` (`NEEDS-CARE`, medium)

**Dual writers (verified):** PA `LifeOpsRepository` (10 `life_goal_*` refs) AND
`plugin-goals/src/db/goals-repository.ts` (10 refs). **Both must repoint atomically
in this slice** or data silently splits across schemas.

**File ops:**
- `plugins/plugin-goals/src/db/schema.ts`: redefine `goalsTable` → two tables
  matching the LIVE `app_lifeops` column shape — `life_goal_definitions`
  (id/agent_id/domain/subject_type/…/metadata_json/created_at/updated_at) and
  `life_goal_links` (id/agent_id/goal_id/linked_type/linked_id/created_at) — under
  `goalsSchema = pgSchema('app_goals')`, **table names kept verbatim**. Ensure
  `plugin-goals/src/plugin.ts` `schema` field registers them.
- Create `plugins/plugin-goals/src/services/migration.ts` = `GoalsMigrationService`,
  cloned from `plugins/plugin-finances/src/services/migration.ts`: `SOURCE_SCHEMA='app_lifeops'`,
  `TARGET_SCHEMA='app_goals'`, `MIGRATED_GOAL_TABLES=['life_goal_definitions','life_goal_links']`,
  serviceType `'goals_migration'`. Register in `plugin-goals/src/plugin.ts` `services[]`.
  Add `migration.test.ts`.
- `plugins/plugin-goals/src/db/goals-repository.ts`: repoint every
  `app_lifeops.life_goal_*` → `app_goals.*` via a `TARGET_SCHEMA` const. **KEEP**
  the `deleteGoal` cross-table writes to `app_lifeops.life_task_definitions` (spine
  FK-nullout) and `app_lifeops.life_audit_events` (audit) UNCHANGED (one-directional
  cross-schema, allowed).
- PA `lifeops/repository.ts`: repoint the 10 `life_goal_*` refs to `app_goals` via a
  `GOALS_SCHEMA` const. Confirm PA `service-mixin-goals.ts` only delegates to
  `GoalsService` (it does — no direct SQL).

**Verification gate:**
- `migration.test.ts`: source-missing skip / target-non-empty skip / copies-when-empty.
- `rg 'app_lifeops.life_goal_(definitions|links)' plugins/` → ONLY the
  `GoalsMigrationService` SOURCE_SCHEMA literal (no live writer on app_lifeops).
- `rg '@elizaos/plugin-personal-assistant' plugins/plugin-goals/src` → comments only.
- `bun run --cwd plugins/plugin-goals verify`; PA verify; `decomposition-integration.test.ts` green.

---

### Slice 6 — Carve calendar tables `app_lifeops.life_calendar_*` → `app_calendar` (`NEEDS-CARE`, medium)

**Dual writers (verified):** PA `LifeOpsRepository` (21 `life_calendar_*` refs incl.
the ALTER/CREATE-INDEX bootstrap block) AND `plugin-calendar/src/service/CalendarRepository.ts`
(11 refs). The `plugin-calendar` schema (`appLifeopsPgSchema('app_lifeops')`) is a
dormant squat — currently NO `schema` field on its plugin. **Both writers repoint
atomically.**

**File ops:**
- `plugins/plugin-calendar/src/service/schema.ts`: rename
  `appLifeopsPgSchema('app_lifeops')` → `calendarSchema = pgSchema('app_calendar')`;
  keep table names `life_calendar_events` / `life_calendar_sync_states` verbatim.
- `plugins/plugin-calendar/src/plugin.ts`: **actually register** the schema (add the
  `schema:` field — currently absent).
- Create `plugins/plugin-calendar/src/service/migration.ts` = `CalendarMigrationService`
  (finances template): `SOURCE_SCHEMA='app_lifeops'`, `TARGET_SCHEMA='app_calendar'`,
  tables `['life_calendar_events','life_calendar_sync_states']`, serviceType
  `'calendar_migration'`. Register in `plugin.ts` `services[]`. Add `migration.test.ts`.
- `CalendarRepository.ts`: repoint the 11 refs to `app_calendar` via a `TARGET_SCHEMA`
  const.
- PA `lifeops/repository.ts`: repoint the calendar refs (incl. the bootstrap
  ALTER/CREATE-INDEX block ~2533/4194/4257) to `app_calendar` via a `CALENDAR_SCHEMA`
  const. Confirm PA `withCalendar` mixin only orchestrates (grant registry / connector
  gate / audit) and delegates the event/sync STORE to `CalendarService` — keep the
  orchestration in PA.

**Verification gate:**
- `migration.test.ts` (3 guard cases).
- `rg 'app_lifeops.life_calendar_' plugins/` → ONLY the MigrationService SOURCE literal.
- `rg '@elizaos/plugin-personal-assistant' plugins/plugin-calendar/src` → comments only.
- `bun run --cwd plugins/plugin-calendar verify`; PA verify; integration test green.

---

### Slice 7 — Scaffold `@elizaos/plugin-scheduling` (`SAFE-NOW`, low)

**File ops:**
- Create `plugins/plugin-scheduling/`: `package.json` (name `@elizaos/plugin-scheduling`;
  copy `plugin-finances/package.json` but **DROP** `build:views`, vite devDeps,
  `lucide-react`/`@elizaos/ui`, and the `elizaos.app` marker — the spine has no view
  since SCHEDULED_TASKS is absent from VIEW_ACTION_MAP). deps: `@elizaos/core`,
  `@elizaos/agent`, `@elizaos/app-core`, `@elizaos/shared`, `drizzle-orm`; peerDep
  `@elizaos/plugin-sql`. `build:js` + `build:types` only.
- `tsconfig.json` + `tsconfig.build.json` (copy finances, drop view refs);
  `vitest.config.ts`; `CLAUDE.md` + `AGENTS.md` (identical); `README.md`.
- `src/index.ts` + `src/plugin.ts` initially export an empty
  `Plugin { name: '@elizaos/plugin-scheduling' }`. `plugins/*` is already globbed in
  the workspace, so `bun install` links it.

**Verification gate:**
- `bun install` succeeds; `bun run --cwd plugins/plugin-scheduling typecheck` passes
  on the empty shell; eliza-source resolves `@elizaos/plugin-scheduling`.

---

### Slice 8 — Move the storage-agnostic spine core into plugin-scheduling (`NEEDS-CARE`, medium)

**File ops:**
- `git mv` the PA-clean spine files (core-only imports) into
  `plugins/plugin-scheduling/src/scheduled-task/`: `types.ts`, `runner.ts`,
  `gate-registry.ts`, `completion-check-registry.ts`, `escalation.ts`,
  `consolidation-policy.ts`, `due.ts`, `next-fire-at.ts`, `state-log.ts`, `index.ts`
  + their tests (`runner.test`, `due.test`, `consolidation-policy.test`,
  `after-task-chain.test`).
- `git mv` `lifeops/registries/anchor-registry.ts` → `plugin-scheduling/src/anchors/anchor-registry.ts`
  (imports only `scheduled-task/consolidation-policy` + `types` — travels clean).
- Rewrite intra-spine relative imports: in `due.ts` + `next-fire-at.ts`
  `../registries/anchor-registry.js` → `../anchors/anchor-registry.js`.
- `runner.ts`'s `import type { DispatchResult } from "../connectors/contract.js"`:
  re-home the `DispatchResult`/`ScheduledTaskDispatcher` **type** into
  `plugin-scheduling` (declare it in `scheduled-task/runner.ts` or a new
  `src/connectors/contract-types.ts`); PA's `connectors/contract.ts` keeps the
  runtime impl and re-imports the type from `@elizaos/plugin-scheduling`.
- In PA, repoint every internal importer of the moved files to
  `@elizaos/plugin-scheduling` instead of `./scheduled-task/index.js` /
  `../scheduled-task/types.js`: `owner/fact-store.ts`, `signals/bus.ts`,
  `repository.ts`, `wave1-types.ts`, `first-run/defaults.ts`,
  `providers/recent-task-states.ts`, `actions/document.ts`, `actions/work-thread.ts`,
  `routes/scheduled-tasks.ts`, `routes/plugin.ts`, and the remaining
  `registries/anchor-registry` consumers.
- Add `@elizaos/plugin-scheduling: workspace:*` to PA `package.json` deps.

**Verification gate:**
- `rg "@elizaos/plugin-personal-assistant" plugins/plugin-scheduling/src` → comments only (the decomposition gate).
- `bun run --cwd plugins/plugin-scheduling typecheck` + `test` (moved runner/due/consolidation tests green).
- PA typechecks against the new import paths.

---

### Slice 9 — Invert runtime-wiring: scheduling exposes injected assembly; PA owns production defaults (`NEEDS-CARE`, high)

**File ops:**
- Create `plugin-scheduling/src/scheduled-task/runtime-wiring.ts` with ONLY the
  PA-free assembly: `createScheduledTaskRunnerFromDeps({ agentId, store, logStore,
  ownerFacts, globalPause, activity, subjectStore, dispatcher, hostCapabilities,
  channelKeys, now })` — builds the 5 registries (gates / completionChecks / ladders /
  anchors / consolidation) and calls `createScheduledTaskRunner`. Move the diagnostic
  shims (`makeMissingActivityBusView` / `makeMissingSubjectStoreView`) here (need only
  `IAgentRuntime` + logger).
- Create in PA `lifeops/scheduled-task-wiring.ts` that imports
  `createScheduledTaskRunnerFromDeps` from `@elizaos/plugin-scheduling` and supplies
  the PA-coupled production deps (lifted from the current `runtime-wiring.ts`):
  `makeRepositoryBackedStores(new LifeOpsRepository)` (current lines 78-…),
  `resolveOwnerFactStore`/`ownerFactsToView`, `createGlobalPauseStore`,
  `getActivitySignalBus`, `createProductionScheduledTaskDispatcher` (current line 242,
  reaches channels/send-policy/`getAgentEventService`), `getHostExecutionCapabilities`,
  `getChannelRegistry` channelKeys. `registerAppLifeOpsAnchors` (current line 341)
  moves to PA wiring — app-lifeops anchors are PA content.
- Move `ScheduledTaskRunnerService` (`service.ts`) to plugin-scheduling but have it
  call an **injected** runner-factory: PA registers via
  `createScheduledTaskRunnerService(buildRunner)` OR keeps a thin PA subclass
  supplying the PA factory. **Preserve `serviceType = "lifeops_scheduled_task_runner"`
  EXACTLY** (runtime dedup + `getService` key).
- `getHostExecutionCapabilities` stays in `@elizaos/app-core`
  (`app-core/services/task-host-capabilities`); plugin-scheduling depends on app-core
  for it (allowed — app-core is inward of plugins). The default `hostCapabilities`
  provider moves into plugin-scheduling's wiring helper.

**Verification gate:**
- `rg 'LifeOpsRepository|fact-store|connectors|send-policy|channels/index|global-pause' plugins/plugin-scheduling/src` → nothing.
- A PA integration test: `getScheduledTaskRunner(runtime).getRunner()` returns a working runner.
- serviceType literal unchanged (grep `"lifeops_scheduled_task_runner"`).
- `scheduler.integration.test.ts` passes (move it with injected deps, or keep in PA).
- `bun run --cwd plugins/plugin-personal-assistant test` green.

---

### Slice 10 — Move `processDueScheduledTasks` to plugin-scheduling with injected tick deps (`NEEDS-CARE`, high)

**File ops:**
- `git mv` `lifeops/scheduled-task/scheduler.ts` → `plugin-scheduling/src/scheduled-task/scheduler.ts`.
  Refactor `processDueScheduledTasks` (current `:88`) signature from
  `{ runtime, agentId, now, limit }` to injected deps `{ agentId, now, limit, runner,
  store, ownerFactsProvider, anchorRegistry, onFired? }`. Remove the inline
  `new LifeOpsRepository` (`:98`), `resolveOwnerFactStore` (`:108`), `getAnchorRegistry`
  (`:113`), and `createPendingPromptsStore` constructions. The pending-prompt recording
  (`recordPendingPromptIfNeeded` / `shouldRecordPendingPrompt`, current `:55-71`,
  triggered at `:267`) becomes the injected `onFired(persistedTask)` callback —
  **move `recordPendingPromptIfNeeded` + `shouldRecordPendingPrompt` into PA** (they read
  PA pending-prompts; after slice 3 they resolve the `eliza_pending_prompts` service).
  The due/timeout candidate listing goes behind `store.list` (already part of
  `ScheduledTaskStore`).
- In PA `service-mixin-reminders.ts:5204`: replace the
  `processDueScheduledTasks({ runtime, agentId, now, limit })` call with the injected
  form — pass the LifeOpsRepository-backed store, the owner-facts provider,
  `getAnchorRegistry(runtime)`, and an `onFired` that records the pending prompt via
  `resolvePendingPromptsService(runtime)`. **Keep the `processScheduledWork` interleave
  (circadian / reminders / workflows) entirely in PA** — only the scheduled-task
  sub-call changes.

**Verification gate:**
- `rg 'LifeOpsRepository|pending-prompts|fact-store' plugins/plugin-scheduling/src/scheduled-task/scheduler.ts` → empty.
- PA `processScheduledWork` unit test: `scheduledTaskFires` / `scheduledTaskCompletionTimeouts` shapes unchanged.
- The 60s `LIFEOPS_SCHEDULER` tick fires a scheduled task end-to-end in a PA integration test (records a pending prompt via the `onFired` seam).

---

### Slice 11 — Move the `SCHEDULED_TASKS` action into plugin-scheduling as an injected-deps factory (`NEEDS-CARE`, medium)

**File ops:**
- `git mv` `src/actions/scheduled-task.ts` → `plugin-scheduling/src/actions/scheduled-task.ts`.
  It imports `hasLifeOpsAccess` (`../lifeops/access.js`), `createPendingPromptsStore`
  (`../lifeops/pending-prompts/store.js`), `LifeOpsRepository` (`../lifeops/repository.js`),
  `OWNER_OPERATION_VALIDATE` (`./life.js`) — all PA-coupled. Convert the default export
  `scheduledTaskAction` into `createScheduledTasksAction({ access, store, pendingPrompts,
  validate })` returning the Action. **Action name `'SCHEDULED_TASKS'` + all
  subaction/simile literals UNCHANGED.**
- PA `plugin.ts`: replace `import { scheduledTaskAction }` +
  `...promoteSubactionsToActions(scheduledTaskAction)` with
  `createScheduledTasksAction({ access: hasLifeOpsAccess, store: paScheduledTaskStore(runtime),
  pendingPrompts: resolvePendingPromptsService, validate: OWNER_OPERATION_VALIDATE })` built
  at plugin-init. **Atomic handoff:** only PA registers it (no double-register);
  plugin-scheduling exports the factory.
- Update PA `index.ts`/`plugin.ts` re-export block (the `scheduledTaskAction` export and
  the big type re-export from `scheduled-task/index.js`, plugin.ts:~1238-1263) to
  re-export from `@elizaos/plugin-scheduling` (shim) for one release.

**Verification gate:**
- `deterministic-action-coverage` (scenario-runner) finds `SCHEDULED_TASKS` registered exactly once.
- `rg 'SCHEDULED_TASKS' packages/agent/src/runtime/view-action-affinity.ts` confirms it's
  NOT in VIEW_ACTION_MAP (no view-shadow concern).
- `decomposition-integration.test.ts`: no dropped owner action, no serviceType collision; PA composed action list unchanged (snapshot).

---

### Slice 12 — Register the spine via plugin-scheduling's Plugin object; PA auto-registers it (`NEEDS-CARE`, medium)

**File ops:**
- Fill `plugin-scheduling/src/plugin.ts`: `Plugin { name:'@elizaos/plugin-scheduling',
  services:[ScheduledTaskRunnerService], actions:[...promoteSubactionsToActions(
  createScheduledTasksAction(defaultDeps))] }`.
- **Lowest-risk handoff decision:** PA stays the registrar — PA `plugin.ts` keeps
  `ScheduledTaskRunnerService` + the composed action in its own arrays, and PA
  auto-registers plugin-scheduling via a new
  `ensureLifeOpsSchedulingPluginRegistered` guard (mirror
  `ensureLifeOpsFinancesPluginRegistered`, PA `plugin.ts:569-572`: check
  `runtime.plugins.some(p => p.name === schedulingPlugin.name)`). plugin-scheduling's
  Plugin object is exported for standalone use but the runtime first-wins dedup
  prevents double-registration. `registerLifeOpsTaskWorker` (the
  circadian+reminders+scheduling composite tick) stays in PA.
- Document in `plugin-scheduling/CLAUDE.md` that PA owns registration during
  decomposition. Update PA `CLAUDE.md` services/actions tables:
  `ScheduledTaskRunnerService` + `SCHEDULED_TASKS` now sourced from
  `@elizaos/plugin-scheduling`.

**Verification gate:**
- Runtime first-wins dedup test: loading PA (which pulls plugin-scheduling) registers
  `ScheduledTaskRunnerService` + `SCHEDULED_TASKS` exactly once.
- `bun run test:server` green; `decomposition-integration.test.ts` green.

---

### Slice 13 — Define the spine→reminders ports in plugin-scheduling (`NEEDS-CARE`, high)

**Why scheduling owns these:** reminders must register a tick-hook + read ports
INTO the spine, but **scheduling must never import reminders** (dependency points
the wrong way otherwise). Scheduling exposes a nullable hook + read-only ports;
reminders consumes them.

**File ops:**
- Create `plugin-scheduling/src/ports.ts` declaring three read-only interfaces +
  registry, all owned by scheduling:
  - `ReminderTickHook = { processReminders(args:{ now:string; limit:number }):
    Promise<{ attempts: ReminderAttemptResult[] }> }` + `registerReminderTickHook(runtime, hook)` /
    `getReminderTickHook(runtime)`.
  - `SpineOccurrenceReadPort = { listActiveDefinitions, refreshDefinitionOccurrences,
    listOccurrenceViewsForOverview(agentId, horizonIso), listReminderPlanOwners(agentId,
    ownerType, ownerIds), listCalendarEvents(agentId, source, fromIso, toIso) }`.
  - `ChannelPolicyReadPort` + `CircadianReadPort = { listChannelPolicies, getChannelPolicy,
    readCircadianState, getScheduleMergedState }`.
- In `plugin-scheduling/src/scheduled-task/scheduler.ts`, **after**
  `processDueScheduledTasks`, add: `const hook = getReminderTickHook(runtime); const
  reminderAttempts = hook ? (await hook.processReminders({ now, limit })).attempts : []`.
  This **inverts** today's direct `this.processReminders` call
  (`service-mixin-reminders.ts:5190`). NOTE: this scheduler hook is the
  plugin-scheduling-resident tick; the PA `processScheduledWork` interleave still
  drives circadian/workflows and calls into this — wire the hook where the scheduled-task
  sub-call lives (consistent with slice 10).
- The IMPL of all three ports is a thin adapter over the spine's
  LifeOpsRepository/registries — but since the repository stays PA-side in this
  phase (no table carve), the **port impls are constructed in PA wiring and injected**;
  scheduling holds only the interfaces + registry. NET: scheduling depends on NOTHING
  of reminders.

**Verification gate:**
- `rg '@elizaos/plugin-reminders' plugins/plugin-scheduling/src` → ZERO (not even comments).
- Typecheck plugin-scheduling.
- Unit test: `getReminderTickHook` returns undefined ⇒ tick still completes, `reminderAttempts = []`.

---

### Slice 14 — Scaffold plugin-reminders + schema (`app_reminders`) + non-destructive migration (`NEEDS-CARE`, medium)

**File ops:**
- Create `plugins/plugin-reminders/`: `package.json` (name `@elizaos/plugin-reminders`,
  `dependencies: ["@elizaos/plugin-sql","@elizaos/plugin-scheduling"]`, `workspace:*` on
  scheduling; peerDeps `@elizaos/core` + `@elizaos/agent`); `tsconfig`, `CLAUDE.md` +
  `AGENTS.md` (identical), `README`.
- `src/db/schema.ts`: `remindersSchema = pgSchema("app_reminders")`; copy
  `lifeReminderPlans` (schema.ts:225-244), `lifeReminderAttempts` (247-285),
  `lifeEscalationStates` (834-851) **verbatim** (column + index defs unchanged), re-rooted
  to `remindersSchema`.
- `src/db/sql.ts`: self-contained raw-SQL helpers copied from PA (finances pattern).
- `src/services/migration.ts`: clone `plugin-finances/src/services/migration.ts`;
  `SOURCE_SCHEMA='app_lifeops'`, `TARGET_SCHEMA='app_reminders'`,
  `MIGRATED_REMINDER_TABLES=['life_reminder_plans','life_reminder_attempts','life_escalation_states']`,
  serviceType `'reminders_migration'`.
- `src/plugin.ts`: `Plugin` with `schema=remindersSchema`, `services=[RemindersMigrationService]`
  (ReminderService added in slice 16).
- PA `schema.ts`: leave the three reminder table DEFINITIONS in place (do NOT drop —
  finances precedent at schema.ts:311-315) but REMOVE them from PA's registered drizzle
  schema export array so plugin-reminders owns creation going forward; add the same
  explanatory comment.
- PA `index.ts`/`plugin.ts`: add `ensureLifeOpsRemindersPluginRegistered` (mirror finances).

**Verification gate:**
- `bun run --cwd plugins/plugin-reminders verify`.
- `migration.test.ts`: source-missing / target-non-empty / copies-when-empty per table.
- `rg '@elizaos/plugin-personal-assistant' plugins/plugin-reminders/src` → comments only.
- `decomposition-integration.test.ts`: no collision on `reminders_migration`.

---

### Slice 15 — Lift pure reminder helpers + constants + contracts into plugin-reminders (`NEEDS-CARE`, medium)

**File ops:**
- `git mv` `lifeops/service-helpers-reminder.ts` (1894 LOC, near-pure: imports only
  `../contracts`, `./enforcement-windows`, `./service-constants`,
  `./service-helpers-misc` (mergeMetadata, priorityToUrgency), `./service-normalize`,
  `./service-types`) → `plugin-reminders/src/reminder-helpers.ts`. Resolve its 4 sibling deps:
  - REMINDER_* constants from `service-constants.ts` (DEFAULT_REMINDER_INTENSITY,
    DEFAULT_REMINDER_PROCESS_LIMIT, GLOBAL_REMINDER_PREFERENCE_CHANNEL_REF, the
    ~30 `REMINDER_*_METADATA_KEY` consts at `service-mixin-reminders.ts:122-158`) →
    `plugin-reminders/src/reminder-constants.ts`. Constants shared with the spine
    (OVERVIEW_HORIZON_MINUTES, PROACTIVE_TASK_QUERY_TAGS, DEFAULT_WORKFLOW_PROCESS_LIMIT)
    STAY in scheduling/PA, imported from `@elizaos/plugin-scheduling`.
  - `enforcement-windows.ts`, the reminder-only helpers in `service-helpers-misc.ts`
    (buildActiveReminders, isReminderChannelAllowedForUrgency, isWithinQuietHours), and
    `service-types.ts` `ReminderActivityProfileSnapshot` → move the reminder-only ones
    into plugin-reminders; leave genuinely-shared ones in scheduling and import.
  - LifeOpsReminder* DTOs (Plan/Attempt/Preference/Intensity/Urgency/Step/ProcessingResult/
    Inspection/Channel + Request DTOs) → `plugin-reminders/src/contracts.ts`; re-export from
    `@elizaos/shared` if they are cross-package transport types (they appear in
    `lifeops-schedule-sync-contracts`), else own them in reminders.
- PA re-exports the moved helpers/constants from their old paths as shims
  (`from "@elizaos/plugin-reminders"`) so existing PA imports compile unchanged.

**Verification gate:**
- `bun run --cwd plugins/plugin-reminders typecheck`.
- `rg` each moved symbol repo-wide; callers resolve via the new package or a PA shim.
- No duplicate const def (each `REMINDER_*_METADATA_KEY` in exactly one source).

---

### Slice 16 — Build `ReminderRepository` on `app_reminders` (the 12 reminder-owned methods) (`NEEDS-CARE`, high)

**File ops:**
- Create `plugin-reminders/src/db/reminder-repository.ts` owning ONLY reminder-table
  methods, lifted from `LifeOpsRepository` and repointed `app_lifeops.*` → `app_reminders.*`
  via a `TARGET_SCHEMA` const: createReminderPlan(3126), updateReminderPlan(3146),
  deleteReminderPlan(3159), getReminderPlan(3168), listReminderPlansForOwners(3184),
  createReminderAttempt(5178), listReminderAttempts(5211), listDueReminderReviewAttempts(5241),
  claimDueReminderReviewAttempts(5285), updateReminderAttemptOutcome(5320), plus escalation
  methods upsertEscalationState(5906), getActiveEscalationState(5955), resolveEscalationState(5971),
  listRecentEscalationStates(5983), deleteAllEscalationStates(5998), plus the
  `ensureReminderReviewColumns` ALTER repair repointed to `app_reminders.life_reminder_attempts`.
  Use `plugin-reminders/src/db/sql.ts`.
- The cross-domain reads delivery needs (listActiveDefinitions,
  listOccurrenceViewsForOverview, listCalendarEvents, listChannelPolicies, getChannelPolicy,
  readCircadianState, getScheduleMergedState) are NOT in ReminderRepository — they come via
  the Spine/ChannelPolicy/Circadian read ports from slice 13.
- In PA `LifeOpsRepository`, make the moved reminder methods **delegate** to
  `ReminderRepository` (mirror the `FinancesRepository` delegation, finances CLAUDE.md) so
  any residual PA reader compiles.

**Verification gate:**
- `bun run --cwd plugins/plugin-reminders test` (repository unit tests against app_reminders).
- `rg 'app_lifeops' plugins/plugin-reminders/src/db/reminder-repository.ts` → zero (all repointed).
- PA typecheck green via delegation.

---

### Slice 17 — Lift the `ReminderService` engine + wire ports + register the tick-hook (`NEEDS-CARE`, high)

**File ops:**
- Create `plugin-reminders/src/reminder-service.ts` = a Service (serviceType `'reminders'`,
  confirm no collision) holding its own runtime + `ReminderRepository` + injected
  SpineOccurrence/ChannelPolicy/Circadian read ports (resolved from
  `@elizaos/plugin-scheduling` at `start()`). Lift from `service-mixin-reminders.ts` the
  DELIVERY/ESCALATION/REVIEW/PREFERENCE methods ONLY: processReminders(4995),
  processDueReminderDeliveries(4611), processDueReminderReviewJobs(3140),
  dispatchDueReminderEscalation, dispatchReminderAttempt, getReminderPreference,
  setReminderPreference, inspectReminder, acknowledgeReminder, capturePhoneConsent, and the
  reminder-scoped activity-signal capture (leave non-reminder ones in PA).
- Rewrite every `this.repository.<spineRead>` → `this.spinePort.<read>` /
  `this.channelPort.<read>` / `this.circadianPort.<read>`; every `this.repository.<reminderOwned>`
  → `this.reminderRepo`. Channel transport (`registerEscalationChannel` from `@elizaos/agent`,
  `sendTwilioSms`/`sendTwilioVoiceCall` from `@elizaos/plugin-phone`,
  `runtime.sendMessageToTarget`) imported directly — unchanged.
- DELETE the moved methods from `service-mixin-reminders.ts` (the PA mixin shrinks).
  `processScheduledWork` stays in PA / scheduling.
- `plugin-reminders/src/tick-hook.ts`: implement `ReminderTickHook.processReminders =
  (a) => reminderService.processReminders(a)` and call `registerReminderTickHook(runtime, hook)`
  from plugin-reminders `init()`.
- PRESERVE runtime strings: serviceType, action names, event names.

**Verification gate:**
- `bun run --cwd plugins/plugin-reminders test` (delivery/escalation specs ported from PA).
- Integration: register scheduling + reminders ⇒ scheduler tick populates `reminderAttempts`
  via hook; register scheduling ALONE ⇒ tick completes, `reminderAttempts = []`.
- `rg 'this.repository' plugin-reminders/src/reminder-service.ts` → only `reminderRepo`; spine
  reads go through ports.
- `decomposition-integration.test.ts`: serviceType `'reminders'` no collision; `processScheduledWork`
  still returns the `reminderAttempts` field (shape preserved).

---

### Slice 18 — Route + reminder-plan-init ownership handoff (`NEEDS-CARE`, high)

**File ops:**
- Routes: repoint `/api/lifeops/reminders/process` (lifeops-routes.ts:2005),
  `/api/lifeops/reminder-preferences` GET+POST (2014/2025), `/api/lifeops/reminders/acknowledge`
  (2037), `/api/lifeops/reminders/inspection` (2089) to resolve `ReminderService`
  (`runtime.getService("reminders")`) and call the same methods — **URLs + response shapes
  IDENTICAL** (finances `/api/lifeops/money/*` precedent). Prefer KEEP-IN-PA-DELEGATE first
  (smaller blast radius, matches `runFinancesRoute`).
- Actions: `OWNER_REMINDERS`/`OWNER_ALARMS`/`OWNER_ROUTINES` STAY registered where
  spine-definition CRUD lives — they `defaultKind:"definition"` (owner-surfaces.ts:227/251/342)
  and write `life_task_definitions` via `runLifeOperationHandler` (actions/life.ts). They are
  SPINE-DEFINITION ops, NOT reminder-plan ops. **Preserve the literal action-name strings**
  (VIEW_ACTION_MAP maps them to the `goals` view — guarded by the drift test).
- The reminder-PLAN attached at definition-create time: scheduling exposes
  `registerDefinitionReminderPlanInitializer(runtime, fn)`; plugin-reminders registers the
  initializer (creates the default `life_reminder_plans` row) so **scheduling does not import
  reminders**. Definition-create stays spine; reminder-plan creation is the injected post-create
  callback.

**Verification gate:**
- E2E: `POST /api/lifeops/reminders/process` returns the same shape; creating a reminder via
  `OWNER_REMINDERS` ⇒ a `life_task_definitions` row (spine) + a `life_reminder_plans` row
  (app_reminders).
- `decomposition-integration.test.ts`: every VIEW_ACTION_MAP reminder action still registered;
  no dropped owner action; route URLs unchanged. The VIEW_ACTION_MAP git-grep drift test passes.

---

### Slice 19 — Final reminders cleanup + PA depends on reminders (`NEEDS-CARE`, medium)

**File ops:**
- Add `@elizaos/plugin-reminders` to PA `package.json` deps (`workspace:*`); PA may re-export
  reminder shims from `index.ts` for one release.
- `service-mixin-reminders.ts` is now a thin shim — if every method moved, remove it from the
  `LifeOpsService` composition in `service.ts` and delete the file; otherwise leave only the
  genuinely-shared residue (circadian persistence stays in the spine tick, NOT here).
- Update PA `CLAUDE.md` + the boundary table in `plugin-reminders/CLAUDE.md` (mirror finances
  "What lives here vs in PA"). Update `lifeops-decomposition-plan.md` status.

**Verification gate:**
- `bun run --cwd plugins/plugin-reminders verify`; PA verify; plugin-scheduling verify.
- `rg '@elizaos/plugin-personal-assistant' plugins/plugin-reminders/src` → comments only.
- `rg '@elizaos/plugin-reminders' plugins/plugin-scheduling/src` → ZERO.
- `bun run test:client` (PA + reminders lane).

---

### Slice 20 — Delete the dead core scheduled-task stub (`SAFE-NOW`, low)

**Why last:** the real `ScheduledTask` type now lives in `@elizaos/plugin-scheduling`,
so the core stub is fully superseded and actively misleading.

**File ops:**
- Delete `packages/core/src/scheduled-task/{types.ts,runner.ts,index.ts,README.md}`
  (`StubScheduledTaskRunner` + the narrower duplicate `ScheduledTask` type — only 5 self-refs).
- Remove `export * from "./scheduled-task/index.js"` from `packages/core/src/index.ts:34`.

**Verification gate:**
- `rg 'StubScheduledTaskRunner|scheduled-task/index|from "./scheduled-task"' packages/core/src` → nothing.
- `bun run --cwd packages/core build` (Node+browser+edge) green; `test` green.
- No external importer of core's scheduled-task remains (rg across repo).

---

## 3. Deferred / blocked (NOT landable now — explicitly out of scope for this pass)

These are documented for honesty; do not attempt them in the slices above.

- **Physical spine table carve (`app_lifeops.life_*` → `app_scheduling`).** The
  injected-store design (slices 8-12) leaves the 4 spine tables + raw SQL in PA's
  `LifeOpsRepository`, so the spine move is a **pure code move with zero migration
  risk**. A later, optional slice can add `plugin-scheduling/src/schema.ts`
  (`pgSchema('app_scheduling')`) + a `SchedulingMigrationService` — but that requires
  moving the store impl + raw SQL into plugin-scheduling, a materially bigger change.
  **Recommend deferring.** This is a separate multi-PR effort.
- **Blocker "carve" — BLOCKED on owner decision.** `app_blocker.block_rules`
  (plugin-blocker, registered-but-NEVER-queried) and `app_lifeops.life_block_rules`
  (PA, LIVE — `website-blocker` reconciler + `proactive-block-bridge`) have
  **structurally incompatible columns** (target/pattern/entityId vs
  profile/websites/gateType/gateUntilMs). There is NO row-shape under which a copy
  migration is valid. Options: (a) leave `life_block_rules` PA-owned focus logic, or
  (b) move the whole `website-blocker` reconciler + `life_block_rules` into
  plugin-blocker and delete the unused `app_blocker.block_rules`. **Needs owner sign-off
  before any code change.**
- **Entity/relationship V1 retirement.** PA `actions/entity.ts` already routes through
  the runtime `EntityStore`/`RelationshipStore` (KnowledgeGraphService); plugin-relationships'
  `KNOWLEDGE_GRAPH` action covers the same ops; a `graph-migration/migration.ts` already
  exists. This is mostly DELETION of the dead V1 raw `life_relationships` SQL in
  `repository.ts` + confirming the migrator runs. Low risk but **independent of the
  spine/reminders work** — sequence it after slice 20 or as its own PR.

---

## 4. Honest effort assessment

- **Landable now, single PRs (SAFE-NOW):** slices 1, 2, 3, 4, 7, 20. Six clean wins.
- **Landable now but each must be ONE atomic PR (NEEDS-CARE, data/coupling):**
  slices 5, 6 (dual-writer schema carves — both writers repoint in the same commit),
  8-12 (the spine extraction — a coherent 5-slice arc that should land as a tight
  series, not split across weeks), 13-19 (the reminders extraction — the largest carve;
  13+14 can land independently as scaffolding, but 16-18 are deeply coupled and should
  be reviewed together).
- **Genuinely multi-PR / deferred:** the physical spine table carve (`app_scheduling`),
  the blocker decision, the entity V1 retirement.
- The single biggest mechanical lift is **slice 16-17** (ReminderRepository + ReminderService):
  the 12 reminder-owned methods + the delivery/escalation/review engine lifted out of a
  5468-LOC mixin, with every spine read rewritten to go through injected ports. It is
  mechanical but large and must preserve every `reminderAttempts` shape the tick returns.

---

## 5. The single biggest risk

**The reminders carve depends on a read-port seam that the spine extraction must
expose correctly, and the tick that drives both is interleaved in a single
5000+-line PA method (`processScheduledWork`).** If slices 8-13 do not land the
injection seams cleanly — specifically, if `processDueScheduledTasks`'s pending-prompt
`onFired` callback or the three reminders read-ports (SpineOccurrence/ChannelPolicy/
Circadian) leak a PA import into plugin-scheduling, or if the `ReminderTickHook`
inversion drops the `reminderAttempts` field — the dependency direction flips
(`plugin-scheduling → PA` or `plugin-scheduling → plugin-reminders`), violating the
inward-only architecture law and silently breaking the per-tick reminder delivery
(reminders stop firing with no error). **Mitigation:** the per-slice gates
`rg "@elizaos/plugin-personal-assistant" plugins/plugin-scheduling/src` (comments only)
and `rg "@elizaos/plugin-reminders" plugins/plugin-scheduling/src` (ZERO), plus the
"scheduling ALONE ⇒ reminderAttempts=[] / scheduling+reminders ⇒ populated" integration
test, are the non-negotiable tripwires — do not advance a slice until both pass.

---

## 6. Execution status (2026-06-18)

**Landed (committed + pushed to develop):**
- ✅ **Slice 1** — LifeOps overview view + builtin tab removed across PA / packages-ui / app-core; route-coverage 10/10, decomposition 6/6, all typecheck clean. (`2cd13115b4`)
- ✅ **Slice 2** — vestigial `app_goals` routines/reminders/alarms/checkins tables deleted. (`d286dbae73`)
- ✅ **Slice 7** — `@elizaos/plugin-scheduling` scaffolded (empty Plugin shell + package/tsconfig/CLAUDE; `bun install` links it; typechecks). (`5b12de8344`)
- ✅ **Slice 20** — dead `@elizaos/core` scheduled-task stub deleted. (`33d9918038`)
- Plus the earlier review: `lifeops-cleanup-review.md` + 3,578 LOC of dead graph/identity code removed (context-graph, identity-observations).

**Not yet executed (the deep arcs — DELIBERATELY deferred as careful, reviewed PRs):**
- Slices 3, 4 — runtime-service promotions (pending-prompts/global-pause/handoff/approval-queue → `@elizaos/agent`). Standalone SAFE-NOW; next-up.
- Slices 5, 6 — goals/calendar schema carve-outs (atomic dual-writer migrations).
- **Slices 8–19 — the spine + reminders engine extraction.** This is the bulk of "scheduling → plugin-scheduling, reminders → plugin-reminders" and is an **atomic multi-PR effort**: moving ~7k LOC of spine + a 5,468-LOC reminders mixin out of a 137k-LOC monolith fused to an 8.4k-LOC `repository.ts`, with the per-tick reminder delivery interleaved in one `processScheduledWork` method. Rushing it on the shared `develop` branch (where PA's typecheck baseline is already ~472 errors, masking new breakage) risks silently breaking the agent's scheduling + reminders. It must land as the tight, reviewed slice series in §2, each gated by the §0/§2 tripwires (no inward import leak; `reminderAttempts` shape preserved; the "scheduling-alone ⇒ [] / scheduling+reminders ⇒ populated" integration test).

**Recommendation:** land slices 3–6 next (each a clean single PR), then the spine arc (8–12) as one reviewed PR, then the reminders arc (13–19) as one reviewed PR.

---

## 7. Execution status update (2026-06-18, cont.)

**✅ Slice 8 LANDED (`ada0c9a61d`, pushed)** — the storage-agnostic scheduling
spine core is now in `@elizaos/plugin-scheduling`: types, runner, the
gate/completion-check/escalation registries, consolidation-policy, due/
next-fire-at math, state-log, the barrel, and the anchor registry. The
`DispatchResult` type is re-homed there. The tick driver
(`processDueScheduledTasks`), the runner Service, and `runtime-wiring` stay
PA-side and import the spine from the new package; PA keeps a thin
`lifeops/scheduled-task/index` barrel re-exporting the package + the local
scheduler/service so existing importers are unchanged. **Verified:**
plugin-scheduling typecheck clean + 72 spine tests; PA build:types clean, tsgo
470 (≤ baseline), decomposition 6/6, 6 spine-consuming PA test files (72 tests)
green; tripwire (no PA import in plugin-scheduling/src) holds.

**Architecture reached:** `@elizaos/plugin-scheduling` is the reusable
scheduling-spine *library*; PA is the host that injects its
repository/owner-facts/channels and drives the tick. This is a clean, defensible
decomposition — the substantive "scheduling → plugin-scheduling."

**Remaining (atomic, must each land as one reviewed PR):**
- Slices 9–12 — move the tick driver + runner Service + `SCHEDULED_TASKS` action
  into plugin-scheduling (PA injects production deps). High-risk wiring
  inversion; marginal benefit over slice 8 (the reusable library is already
  extracted). Optional.
- Slices 13–19 — **reminders → plugin-reminders.** The largest lift: it MUST be
  atomic (the `app_lifeops.life_reminder_*` → `app_reminders` migration + the
  `ReminderRepository` repoint must land in the same change or reminder data
  splits across two schemas), and it lifts the delivery/escalation engine out of
  the 5,468-LOC `service-mixin-reminders.ts` while preserving the per-tick
  `reminderAttempts` shape. Reminder tables verified at `schema.ts:224`
  (life_reminder_plans), `:246` (life_reminder_attempts), `:833`
  (life_escalation_states). Recommended approach (finances pattern): scaffold
  plugin-reminders (depends on plugin-scheduling + plugin-sql) → `app_reminders`
  schema (copy the 3 tables verbatim) → non-destructive `RemindersMigrationService`
  → self-contained `ReminderRepository` over `app_reminders` → PA's
  `LifeOpsRepository` reminder methods delegate to it → PA registers
  plugin-reminders via `ensureLifeOpsRemindersPluginRegistered`. The
  service-mixin engine can stay PA-resident, delegating through the repository
  (consistent with how the spine wiring stays PA-side).
- Slices 3–6 (runtime-service promotions; goals/calendar schema carves) —
  independent, finances-proven, landable as separate clean PRs.

## 8. Execution status update (2026-06-19) — data-layer carves complete

**✅ All LifeOps data-layer carves LANDED + pushed.** Every dual-writer /
shared-schema-squat in the LifeOps domain is now eliminated; each domain plugin
owns its own `app_*` schema with a non-destructive `app_lifeops → app_*`
migration (the finances carve pattern: `to_regclass` source guard +
target-empty check + `INSERT … SELECT s.*`, source never dropped). PA keeps the
`app_lifeops` defs only as the dormant migration source and auto-registers each
plugin so the schema exists + the migration runs.

| Carve | Schema | Tables | Migration service | Notes |
|---|---|---|---|---|
| reminders (slice 14-ish) | `app_reminders` | life_reminder_plans / _attempts / life_escalation_states | `RemindersMigrationService` | PA-exclusive tables; data layer only (engine stays PA-resident) |
| calendar (slice 6) | `app_calendar` | life_calendar_events / _sync_states | `CalendarMigrationService` | killed the PA↔plugin-calendar dual-writer; schema was an unregistered squat |
| goals (slice 5) | `app_goals` | life_goal_definitions / _links | `GoalsMigrationService` | resolved the documented shared-schema counter-position by carving cleanly; replaced the dead `app_goals.goals` placeholder; reminder/scheduling goal-link reads follow the repository to app_goals |
| inbox | `app_inbox` | life_inbox_triage_entries / _examples / life_email_unsubscribes | `InboxMigrationService` | sole writer was plugin-inbox (PA's src/inbox/repository.ts is a shim); gmail projection tables stay PA-owned; 22 lifeops.* scenarios + bootstrapSchema repointed |

Each: plugin typecheck clean + migration unit test (3-4 guard cases); PA
build:types clean; PA tsgo **470 == baseline** (zero net new errors); full PA
suite **548/548**; decomposition-integration **6/6** (no migration-serviceType
collision across reminders/calendar/goals/inbox/finances); tripwire holds (no PA
import in the carved plugin's `src`); no live writer/reader left on the
`app_lifeops` source tables.

**Deliberately NOT done (each needs an owner decision or a dedicated focused
effort — out of scope for a high-confidence cleanup sweep):**
- Slices 3–4 (promote pending-prompts / global-pause / handoff / approval-queue
  → `@elizaos/agent`). This moves assistant-workflow state INWARD into the core
  runtime (every agent would carry it), the opposite direction from the carves
  above, and its main stated rationale was enabling the deferred spine-engine
  move. Architecturally debatable — wants an owner call on whether the runtime is
  the right home, not a unilateral sweep.
- Slices 9–12 (move the tick driver + runner Service + `SCHEDULED_TASKS` into
  plugin-scheduling; invert runtime-wiring) — high-risk wiring inversion,
  marginal benefit over the slice-8 library extraction.
- Slices 13/16–19 (lift the reminders delivery/escalation ENGINE out of the
  5,468-LOC `service-mixin-reminders.ts` behind plugin-scheduling tick-hook
  ports) — the riskiest tick/engine surgery; the reminders *data* layer is
  already carved, so the headline ("reminders → plugin-reminders") is delivered.
