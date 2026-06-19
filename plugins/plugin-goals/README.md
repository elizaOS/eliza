# @elizaos/plugin-goals

Life direction plugin for elizaOS: owner-set long-horizon goals, recurring
routines, reminders, alarms, daily check-ins, and a self-care / mood / journal
panel.

Decomposed out of `@elizaos/plugin-personal-assistant`. During the migration phase three
of the four action handlers (`OWNER_ROUTINES`, `OWNER_REMINDERS`, `OWNER_ALARMS`) are
scaffold stubs that point back to their LifeOps source via `TODO(migrate)` comments.
`OWNER_GOALS` is fully implemented via `GoalsService`. The plugin registers cleanly,
compiles standalone, and serves a real (if minimal) view.

## Install

```bash
bun add @elizaos/plugin-goals
```

Add the plugin to your agent's plugin list. `@elizaos/plugin-sql` must be
loaded before it (declared as a peer dep + `dependencies: ["@elizaos/plugin-sql"]`
on the plugin object).

## Plugin surface

- Actions: `OWNER_GOALS` (real — CRUD via GoalsService), `OWNER_ROUTINES`, `OWNER_REMINDERS`, `OWNER_ALARMS` (scaffold stubs)
- Back-end: `GoalsService` (`src/goals-service.ts`) — goal CRUD, dedup, similarity scoring
- Service: `GoalsCheckinService` (daily check-in engine, stub)
- View: `goals` (`/goals`) — three sections (Life Goals / Routines / Today)
  plus a self-care / mood / journal panel
- Schema: `pgSchema('app_goals')` with tables `goals`, `routines`,
  `reminders`, `alarms`, `checkins`

## Migration mapping (`plugin-lifeops` -> `plugin-goals`)

| LifeOps source                                                                       | Plugin-goals target                  |
|--------------------------------------------------------------------------------------|--------------------------------------|
| `src/actions/owner-surfaces.ts` (`OWNER_GOALS`)                                       | `src/actions/goals.ts`               |
| `src/actions/owner-surfaces.ts` (`OWNER_ROUTINES`)                                    | `src/actions/routines.ts`            |
| `src/actions/owner-surfaces.ts` (`OWNER_REMINDERS`)                                   | `src/actions/reminders.ts`           |
| `src/actions/owner-surfaces.ts` (`OWNER_ALARMS`)                                      | `src/actions/alarms.ts`              |
| `src/lifeops/checkin/checkin-service.ts` + `schedule-resolver.ts` + `types.ts`        | `src/services/checkin.ts`            |
| `src/followup/followup-tracker.ts` + `src/followup/actions/`                          | `src/followup/` (added in phase 2)   |
| `src/default-packs/{daily-rhythm,habit-starters,followup-starter}.ts`                 | `src/default-packs/` (phase 2)       |
| `src/lifeops/schema.ts` (`app_goals` namespace tables)                                | `src/db/schema.ts`                   |

## Status

`OWNER_GOALS` is fully implemented (goal CRUD via `GoalsService`). The remaining
three owner actions (`OWNER_ROUTINES`, `OWNER_REMINDERS`, `OWNER_ALARMS`) are scaffold
stubs: handlers return `success: false` with a `scaffold_stub` reason and include a
`TODO(migrate)` pointer back to the LifeOps source. The follow-up phase migrates the
real handler bodies + default packs + check-in implementation from `plugin-lifeops`.

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
  actions/{goals,routines,reminders,alarms}.ts
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
