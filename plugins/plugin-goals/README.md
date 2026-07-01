# @elizaos/plugin-goals

Life direction plugin for elizaOS: owner-set long-horizon goals, daily
check-ins, and a self-care / mood / journal panel.

Decomposed out of `@elizaos/plugin-personal-assistant`. This plugin registers
only the fully migrated `OWNER_GOALS` action via `GoalsService`. Routines,
reminders, and alarms remain host-adapted owner surfaces in
`@elizaos/plugin-personal-assistant` and are not exported here.

## Install

```bash
bun add @elizaos/plugin-goals
```

Add the plugin to your agent's plugin list. `@elizaos/plugin-sql` must be
loaded before it (declared as a peer dep + `dependencies: ["@elizaos/plugin-sql"]`
on the plugin object).

## Plugin surface

- Actions: `OWNER_GOALS` (real — CRUD via GoalsService)
- Back-end: `GoalsService` (`src/goals-service.ts`) — goal CRUD, dedup, similarity scoring
- Service: `GoalsCheckinService` (daily check-in engine, stub)
- View: `goals` (`/goals`) — three sections (Life Goals / Routines / Today)
  plus a self-care / mood / journal panel
- Schema: `pgSchema('app_goals')` with the carved goal tables. Reminder /
  alarm / routine delivery state lives in `@elizaos/plugin-reminders`.

## Migration mapping (`plugin-personal-assistant` -> `plugin-goals`)

| LifeOps source                                                                       | Plugin-goals target                  |
|--------------------------------------------------------------------------------------|--------------------------------------|
| `src/actions/owner-surfaces.ts` (`OWNER_GOALS`)                                       | `src/actions/goals.ts`               |
| `src/lifeops/checkin/checkin-service.ts` + `schedule-resolver.ts` + `types.ts`        | `src/services/checkin.ts`            |
| `src/followup/followup-tracker.ts` + `src/followup/actions/`                          | `src/followup/` (added in phase 2)   |
| `src/default-packs/{daily-rhythm,habit-starters,followup-starter}.ts`                 | `src/default-packs/` (phase 2)       |
| `src/lifeops/schema.ts` (`app_goals` namespace tables)                                | `src/db/schema.ts`                   |

## Status

`OWNER_GOALS` is fully implemented (goal CRUD via `GoalsService`). The plugin no
longer ships scaffold actions for routines, reminders, or alarms; those owner
surfaces are registered by `@elizaos/plugin-personal-assistant`.

## Layout

```
src/
  index.ts                       Public barrel
  plugin.ts                      goalsPlugin (actions, service, schema, views)
  types.ts                       Action enums + scope + log prefix
  goals-service.ts               GoalsService (goal CRUD + dedup + scoring)
  goals-runtime.ts               createOwnerGoalsService + owner-scope hooks
  goal-normalize.ts              GoalsServiceError + input normalizers
  goal-grounding.ts              Goal grounding / semantic-review metadata helpers
  goal-semantic-evaluator.ts     evaluateGoalProgressWithLlm (LLM goal review)
  actions/goals.ts
  services/checkin.ts            GoalsCheckinService (stub)
  db/
    index.ts                     Re-exports schema
    schema.ts                    Drizzle pgSchema('app_goals')
    sql.ts                       Self-contained raw-SQL helpers
    goals-repository.ts          GoalsRepository (raw SQL over app_lifeops.life_goal_*)
  components/goals/
    GoalsView.tsx                React view
    goals-view-bundle.ts         Vite view-bundle entry
```

## Commands

```bash
bun run --cwd plugins/plugin-goals typecheck
bun run --cwd plugins/plugin-goals lint
bun run --cwd plugins/plugin-goals test
bun run --cwd plugins/plugin-goals build
```

## License

MIT — see the repo root `LICENSE`.
