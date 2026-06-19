# scheduled-task

Future home of the structural scheduled-task runner currently in
`plugin-personal-assistant/src/lifeops/scheduled-task/`. This module *extends*
`@elizaos/core`'s existing task-scheduler (`src/services/task-scheduler.ts`) —
it does not replace it.

The extensions are the LifeOps-shaped fields the personal-assistant plugin
attaches to a `Task`:

- **gates** — preconditions that must hold for the task to fire (see
  `registries/gate.ts`)
- **escalation** — named ladder of follow-ups when the task is not
  acknowledged (see `registries/escalation-ladder.ts`)
- **completionCheck** — predicate the runner consults to decide whether the
  task is "done" vs. needs another pass
- **anchors** — symbolic time references the schedule resolves against (see
  `registries/anchor.ts`)
- **pipeline hooks** — `beforeFire` / `afterFire` / `onError` callbacks that
  features compose without subclassing the runner

The exported runner is a stub. The real implementation stays in the plugin
until the migration phase tracked below.

## Tracked migration

`TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/scheduled-task/ ->
              packages/core/src/scheduled-task/)`

The base scheduler (`packages/core/src/services/task-scheduler.ts`) stays put;
this directory only adds the lifeops-shaped extensions on top of it.
