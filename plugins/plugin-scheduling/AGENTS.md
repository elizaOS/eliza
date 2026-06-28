# @elizaos/plugin-scheduling

The scheduling spine for elizaOS agents — the storage-agnostic `ScheduledTask`
state machine **and** the always-loaded runtime primitive that HOSTS it. Loaded
on every platform (it is in `CORE_PLUGINS` + `MOBILE_CORE_PLUGINS`).

## Purpose / role

Owns the generic scheduling primitives that any plugin can build on, and the
runtime surface that makes them work standalone:

- The `ScheduledTask` types + the `runner` (storage-agnostic; imports only
  `@elizaos/core` + its own modules).
- Trigger evaluation: `cron` / `interval` / `once` / `event` / `after_task` /
  `relative_to_anchor` / `during_window` (`due.ts`, `next-fire-at.ts`).
- The extensible registries: `TaskGateRegistry`, `CompletionCheckRegistry`,
  escalation-ladder registry, the anchor registry, consolidation policy.
- The runner factory `createScheduledTaskRunner({ … })` — persistence
  (`ScheduledTaskStore`/`ScheduledTaskLogStore`) and the owner/channel/connector
  dependencies are **injected** by the host, not owned here.
- **The runner host service** `ScheduledTaskRunnerService` (serviceType
  `"lifeops_scheduled_task_runner"`, in `scheduled-task/runner-service.ts`) +
  the runtime-injected deps port `registerScheduledTaskRunnerDeps` /
  `getScheduledTaskRunnerDeps`. A built-in **default deps provider** (in-memory
  store, built-in registries, an `in_app`/NOTIFICATION dispatcher, warn-once
  ports, an `ELIZA_PLATFORM`-driven host-capability predicate) runs when no host
  injects production deps — so the runner works on a stock mobile boot.
- **The generic REST surface** at `/api/lifeops/scheduled-tasks`
  (`routes/scheduled-tasks.ts` + `routes/plugin-routes.ts`), registered via the
  plugin's `routes:` array on every platform (path unchanged for the UI).
- **The default-pack seed registry** (`scheduled-task/seed-registry.ts`):
  consumers register packs via `registerDefaultTaskPack`; a boot seeder
  materializes them seed-once. This plugin ships ZERO packs.
- The spine→reminders ports (`ReminderTickHook` + read ports): reminders
  REGISTER a tick-hook into the spine so `@elizaos/plugin-scheduling` never
  imports `@elizaos/plugin-reminders` (dependency points inward).

**Boundary:** `@elizaos/plugin-scheduling` MUST NOT import
`@elizaos/plugin-personal-assistant`, `@elizaos/plugin-reminders`,
`@elizaos/app-core`, or `@elizaos/agent` (those would break the mobile bundle).
A host (`@elizaos/plugin-personal-assistant`) injects the production deps via
`registerScheduledTaskRunnerDeps` (first-wins) and registers its domain packs +
the `SCHEDULED_TASKS` action; PA's dev `/api/lifeops/dev/registries` composite
stays PA-side. Tables stay in PA's `app_lifeops` and are reached via the
injected store (a later optional carve can move them to `app_scheduling`).

Gate: `rg "@elizaos/(app-core|agent|plugin-personal-assistant|plugin-google)"
plugins/plugin-scheduling/src` must return comments/strings only.

See `plugins/plugin-personal-assistant/docs/lifeops-extraction-plan.md` for the
full extraction sequence.

## Commands

```bash
bun run --cwd plugins/plugin-scheduling typecheck
bun run --cwd plugins/plugin-scheduling test
bun run --cwd plugins/plugin-scheduling build
```

See the root `AGENTS.md` for repo-wide architecture rules.
