# @elizaos/plugin-goals

Life direction plugin for elizaOS: owner-set long-horizon goals, recurring
routines, reminders, alarms, daily check-ins, and a self-care / mood / journal
panel.

## Purpose / role

Decomposed out of `@elizaos/plugin-personal-assistant` to make the "life direction"
surface a self-contained plugin. Owns the four owner actions
(`OWNER_GOALS`, `OWNER_ROUTINES`, `OWNER_REMINDERS`, `OWNER_ALARMS`), the
check-in engine (`GoalsCheckinService`), the corresponding drizzle
`pgSchema('app_goals')` tables, and the desktop `goals` view.

The plugin is opt-in — add it to the agent's plugin list. It depends on
`@elizaos/plugin-sql` for the database.

## Plugin surface

### Actions
- **`OWNER_GOALS`** (`src/actions/goals.ts`) — create / update / delete /
  review long-horizon life goals.
- **`OWNER_ROUTINES`** (`src/actions/routines.ts`) — recurring routines
  (daily / weekly / custom cadence). Default packs come from
  `plugin-lifeops/src/default-packs/daily-rhythm.ts` and `habit-starters.ts`
  (still to migrate).
- **`OWNER_REMINDERS`** (`src/actions/reminders.ts`) — owner-facing surface
  over Apple Reminders / Google Tasks bridges (which live in their own
  plugins).
- **`OWNER_ALARMS`** (`src/actions/alarms.ts`) — wake / notification alarms
  with repeat rules.

All four are currently **scaffold stubs**; handlers return
`success: false` with a `scaffold_stub` reason and include a `TODO(migrate)`
pointer back to the LifeOps source.

### Services
- **`GoalsCheckinService`** (`src/services/checkin.ts`) — daily check-in
  engine. Stub. Will absorb the LifeOps `CheckinService`
  (`plugin-lifeops/src/lifeops/checkin/checkin-service.ts`).

### Views
- **`goals`** — `GoalsView` (`src/components/goals/GoalsView.tsx`); path
  `/goals`. Three sections (Life Goals / Routines / Today) plus a self-care
  panel.

### Schema
- `goalsSchema` (`src/db/schema.ts`) — `pgSchema("app_goals")` with tables
  `goals`, `routines`, `reminders`, `alarms`, `checkins`. Exported as
  `schema` on the plugin object so the runtime registers migrations.

## Layout

```
src/
  index.ts                       Public barrel
  plugin.ts                      Plugin object (actions, service, schema, views)
  types.ts                       Action enums, contexts, scope, log prefix
  actions/
    goals.ts                     OWNER_GOALS (stub)
    routines.ts                  OWNER_ROUTINES (stub)
    reminders.ts                 OWNER_REMINDERS (stub)
    alarms.ts                    OWNER_ALARMS (stub)
  services/
    checkin.ts                   GoalsCheckinService (stub)
  db/
    index.ts                     Re-exports schema
    schema.ts                    Drizzle pgSchema('app_goals')
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

## Migration mapping (plugin-lifeops -> plugin-goals)

| Owner surface                | Source in plugin-lifeops                                                                  | Target here                              |
|-----------------------------|-------------------------------------------------------------------------------------------|------------------------------------------|
| `OWNER_GOALS`                | `src/actions/owner-surfaces.ts` (search `OWNER_GOAL_ACTIONS`)                              | `src/actions/goals.ts`                   |
| `OWNER_ROUTINES`             | `src/actions/owner-surfaces.ts` (search `OWNER_LIFE_ACTIONS` / `ownerRoutinesAction`)      | `src/actions/routines.ts`                |
| `OWNER_REMINDERS`            | `src/actions/owner-surfaces.ts`                                                            | `src/actions/reminders.ts`               |
| `OWNER_ALARMS`               | `src/actions/owner-surfaces.ts`                                                            | `src/actions/alarms.ts`                  |
| Daily check-in engine        | `src/lifeops/checkin/checkin-service.ts`, `schedule-resolver.ts`, `types.ts`               | `src/services/checkin.ts` (+ types)      |
| Follow-up watcher            | `src/followup/followup-tracker.ts`, `src/followup/actions/`                                | `src/followup/` (to add)                 |
| Default packs                | `src/default-packs/daily-rhythm.ts`, `habit-starters.ts`, `followup-starter.ts`            | `src/default-packs/` (to add)            |
| Schema (goals + check-ins)   | `src/lifeops/schema.ts` (`app_goals` namespace)                                            | `src/db/schema.ts`                       |

`plugin-lifeops` keeps its own copies for now; the actions there will
re-export from this package once the bodies move.

## Conventions / gotchas

- **Schema namespace is `app_goals`.** Do not collide with other
  decomposed plugins; keep all goals/routine/reminder/alarm/checkin tables in
  this namespace.
- **Actions are scaffold stubs.** They register and validate but return a
  `scaffold_stub` reason. Real bodies come during the migration pass.
- **View bundles separately.** `build:views` (Vite) produces
  `dist/views/bundle.js`. The `bundlePath` on the view registration points
  there. The tsup `build:js` and the vite `build:views` are independent.
- **Owner scope.** All four actions are owner-scoped (`roleGate: ADMIN`,
  contexts `goals` / `self_care` / `owner`).
- See the root `AGENTS.md` for repo-wide architecture rules.
