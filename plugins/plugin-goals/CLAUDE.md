# @elizaos/plugin-goals

Life direction plugin for elizaOS: owner-set long-horizon goals, daily
check-ins, and a self-care / mood / journal panel.

## Purpose / role

Decomposed out of `@elizaos/plugin-personal-assistant` to make the "life direction"
surface a self-contained plugin. Owns the fully migrated `OWNER_GOALS` action,
the check-in service (`GoalsCheckinService`), the corresponding drizzle
`pgSchema('app_goals')` tables, and the desktop `goals` view. Routines,
reminders, and alarms remain host-adapted owner surfaces in
`@elizaos/plugin-personal-assistant` and are not exported here.

The plugin is opt-in — add it to the agent's plugin list. It depends on
`@elizaos/plugin-sql` for the database.

## Plugin surface

### Actions
- **`OWNER_GOALS`** (`src/actions/goals.ts`) — **real**: create / update /
  delete / review long-horizon life goals. Resolves the subaction + params via
  `resolveActionArgs` (`@elizaos/core`) and dispatches to the goals back-end
  (`GoalsService`). Owner-scoped (ADMIN). When `@elizaos/plugin-personal-assistant`
  is loaded it registers its own richer natural-language `OWNER_GOALS` flow
  first (first-registration wins), which delegates to the same `GoalsService`
  CRUD; this self-contained action is the PA-free topology surface.
`OWNER_ROUTINES`, `OWNER_REMINDERS`, and `OWNER_ALARMS` are registered by
`@elizaos/plugin-personal-assistant` while their data-layer work remains split
across `@elizaos/plugin-reminders` and the shared scheduled-task runner.

### Back-end (the goal domain home)
- **`GoalsService`** (`src/goals-service.ts`) — goal CRUD (`createGoal` /
  `updateGoal` / `getGoal` / `listGoals` / `deleteGoal`) + near-duplicate dedup
  + similarity scoring (`scoreGoalSimilarity`). Standalone successor to the goal
  CRUD half of PA's `withGoals` mixin; holds its own runtime +
  `GoalsRepository`. Throws `GoalsServiceError` (HTTP status) on invalid input.
  Takes two PA-owned concerns as injected hooks: `recordAudit` (the shared
  `app_lifeops` audit store) and `normalizeOwnership` (PA domain / identity
  rules). Cross-domain goal review / overview / experience-loop logic is NOT
  here — it aggregates PA's definition / occurrence / reminder / calendar graph
  and stays in PA's `withGoals` mixin, which delegates its goal CRUD here.
- **`GoalsRepository`** (`src/db/goals-repository.ts`) — raw SQL over the goal
  tables (`life_goal_definitions` / `life_goal_links`), now owned by this plugin
  in the `app_goals` schema (carved out of PA's `app_lifeops` via
  `GoalsMigrationService`). PA's reminder/scheduling subsystem still reads +
  writes goal links, but it does so through PA's repository, whose SQL was
  repointed to `app_goals` in the same carve — so a single owner backs every
  reader. The cross-schema writes to `app_lifeops.life_task_definitions` (the
  spine FK-nullout in `deleteGoal`) and `app_lifeops.life_audit_events` (audit)
  stay on `app_lifeops`. Reaches the DB through the self-contained
  `src/db/sql.ts` helpers.
- **`goal-grounding.ts`** / **`goal-semantic-evaluator.ts`** — goal grounding
  metadata + the LLM-backed `evaluateGoalProgressWithLlm`. PA re-exports these
  from here for back-compat (`plugin-personal-assistant/src/lifeops/goal-grounding.ts`
  is now a thin shim).
- **`createOwnerGoalsService`** (`src/goals-runtime.ts`) — builds a
  `GoalsService` for the standalone action/routes with default owner-scope
  hooks (PA-free topology).

### Services
- **`GoalsCheckinService`** (`src/services/checkin.ts`) — daily check-in
  engine. Stub. Will absorb the PA `CheckinService`
  (`plugin-personal-assistant/src/lifeops/checkin/checkin-service.ts`).

### Views
- **`goals`** — `GoalsView` (`src/components/goals/GoalsView.tsx`); path
  `/goals`. Three sections (Life Goals / Routines / Today) plus a self-care
  panel.

### Schema
- `goalsSchema` (`src/db/schema.ts`) — `pgSchema("app_goals")` with the carved
  goal tables `life_goal_definitions` + `life_goal_links` (lifted from PA's
  `app_lifeops`, column shape verbatim). `GoalsMigrationService`
  (`src/services/migration.ts`) does the non-destructive copy. The vestigial
  `routines`/`reminders`/`alarms`/`checkins` and the old placeholder `goals`
  table were removed — reminders/alarms/routines now live in
  `@elizaos/plugin-reminders` (`app_reminders`). Exported as `schema` on the
  plugin object so the runtime registers migrations.

## Layout

```
src/
  index.ts                       Public barrel
  plugin.ts                      Plugin object (actions, service, schema, views)
  types.ts                       Action enums, contexts, scope, log prefix
  goals-service.ts               GoalsService (goal CRUD + dedup + scoring)
  goals-runtime.ts               createOwnerGoalsService + owner-scope hooks
  goal-normalize.ts              GoalsServiceError + input normalizers (self-contained)
  goal-grounding.ts              Goal grounding / semantic-review metadata helpers
  goal-semantic-evaluator.ts     evaluateGoalProgressWithLlm (LLM goal review)
  actions/
    goals.ts                     OWNER_GOALS (real — CRUD via GoalsService)
  services/
    checkin.ts                   GoalsCheckinService (stub)
  db/
    index.ts                     Re-exports schema
    schema.ts                    Drizzle pgSchema('app_goals')
    sql.ts                       Self-contained raw-SQL helpers (runtime DB)
    goals-repository.ts          GoalsRepository (raw SQL over app_goals.life_goal_*)
  components/
    goals/
      GoalsView.tsx              React view (sections + self-care)
      goals-view-bundle.ts       Vite view-bundle entry
```

## Commands

```bash
bun run --cwd plugins/plugin-goals typecheck     # tsc --noEmit
bun run --cwd plugins/plugin-goals lint          # biome check src/
bun run --cwd plugins/plugin-goals test          # vitest run
bun run --cwd plugins/plugin-goals build         # build:js + build:views + build:types
bun run --cwd plugins/plugin-goals build:js      # tsup (shared config)
bun run --cwd plugins/plugin-goals build:views   # vite build for the goals view bundle
bun run --cwd plugins/plugin-goals build:types   # tsc declaration emit
bun run --cwd plugins/plugin-goals clean         # rm -rf dist
```

## Migration mapping (personal-assistant -> plugin-goals)

| Owner surface                | Source in personal-assistant                                                              | Target here                              |
|-----------------------------|-------------------------------------------------------------------------------------------|------------------------------------------|
| `OWNER_GOALS`                | `src/actions/owner-surfaces.ts` (search `OWNER_GOAL_ACTIONS`)                              | `src/actions/goals.ts`                   |
| Daily check-in engine        | `src/lifeops/checkin/checkin-service.ts`, `schedule-resolver.ts`, `types.ts`               | `src/services/checkin.ts` (+ types)      |
| Follow-up watcher            | `src/followup/followup-tracker.ts`, `src/followup/actions/`                                | `src/followup/` (to add)                 |
| Default packs                | `src/default-packs/daily-rhythm.ts`, `habit-starters.ts`, `followup-starter.ts`            | `src/default-packs/` (to add)            |
| Schema (goals + check-ins)   | `src/lifeops/schema.ts` (`app_goals` namespace)                                            | `src/db/schema.ts`                       |

PA keeps the non-goal owner action orchestration for now. Do not re-add local
stubs for those actions; migrate the real behavior with parity tests if
ownership changes.

## Boundary with plugin-personal-assistant

- `@elizaos/plugin-goals` MUST NOT import `@elizaos/plugin-personal-assistant`
  (verify: `rg 'from "@elizaos/plugin-personal-assistant"' plugins/plugin-goals/src`
  stays empty). Shared contract types come from `@elizaos/shared`.
- This plugin owns the goal **tables** (`life_goal_definitions` /
  `life_goal_links` in `app_goals`, carved out of PA's `app_lifeops`). PA's
  reminder/scheduling subsystem still reads + writes goal links, but through
  PA's repository, whose SQL was repointed to `app_goals` in the same carve.
  PA delegates its goal CRUD to this plugin's `GoalsService` (so the
  `/api/lifeops/goals*` routes + the `GoalsView` wire shape stay byte-identical),
  and re-exports the goal grounding/evaluator modules from here. PA
  auto-registers this plugin (`ensureLifeOpsGoalsPluginRegistered`) so the
  `app_goals` schema exists and the non-destructive migration runs whenever PA
  is loaded.
- Cross-domain goal **review / overview / experience-loop** stays in PA's
  `withGoals` mixin (it aggregates the definition / occurrence / reminder /
  calendar graph PA owns).

## Conventions / gotchas

- **Schema namespace is `app_goals`.** The goal tables
  (`life_goal_definitions` / `life_goal_links`) were carved out of PA's
  `app_lifeops` into `app_goals`, owned here, registered via the plugin `schema`
  field; `GoalsMigrationService` performs the non-destructive one-time copy of
  any existing `app_lifeops` rows (finances/reminders/calendar carve pattern:
  skip if source missing / target non-empty, never drop the source). Requires
  `@elizaos/plugin-sql` loaded first. PA auto-registers this plugin
  (`ensureLifeOpsGoalsPluginRegistered`) so `app_goals` exists and the migration
  runs whenever PA is loaded.
- **`src/db/sql.ts` is a self-contained copy** of PA's raw-SQL helpers (so the
  back-end carries no PA dependency). Keep it in sync only if a correctness fix
  applies to both; do not add goals-specific logic.
- **Only OWNER_GOALS is registered here.** Routines, reminders, and alarms are
  PA-owned owner actions; this package owns the goal CRUD/domain service.
- **View bundles separately.** `build:views` (Vite) produces
  `dist/views/bundle.js`. The `bundlePath` on the view registration points
  there. The tsup `build:js` and the vite `build:views` are independent.
- **Owner scope.** `OWNER_GOALS` is owner-scoped (`roleGate: ADMIN`, contexts
  `goals` / `self_care` / `owner`).
- See the root `AGENTS.md` for repo-wide architecture rules.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — agent behavior / app plugin:**
- A **live-LLM** scenario trajectory showing the behavior end to end and asserting the **outcome**, not just that routing/an action was selected (see #9970).
- The artifacts the behavior creates — memories, knowledge, scheduled-task rows, relationships, documents, outputs — inspected after the run.
- Backend `[ClassName]` logs of the action/service/runner firing, plus error/edge/permission paths.
- The empty-state and adversarial-input behavior, not just one happy scenario.
<!-- END: evidence-and-e2e-mandate -->
