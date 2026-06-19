# @elizaos/plugin-scheduling

The scheduling spine for elizaOS agents — the storage-agnostic `ScheduledTask`
state machine extracted from `@elizaos/plugin-personal-assistant` (LifeOps).

## Purpose / role

Owns the generic scheduling primitives that any plugin can build on:

- The `ScheduledTask` types + the `runner` (storage-agnostic; imports only
  `@elizaos/core` + its own modules).
- Trigger evaluation: `cron` / `interval` / `once` / `event` / `after_task` /
  `relative_to_anchor` / `during_window` (`due.ts`, `next-fire-at.ts`).
- The extensible registries: `TaskGateRegistry`, `CompletionCheckRegistry`,
  escalation-ladder registry, the anchor registry, consolidation policy.
- The runner factory `createScheduledTaskRunnerFromDeps({ … })` — persistence
  (`ScheduledTaskStore`/`ScheduledTaskLogStore`) and the owner/channel/connector
  dependencies are **injected** by the host, not owned here.
- The spine→reminders ports (`ReminderTickHook` + read ports): reminders
  REGISTER a tick-hook into the spine so `@elizaos/plugin-scheduling` never
  imports `@elizaos/plugin-reminders` (dependency points inward).

**Boundary:** `@elizaos/plugin-scheduling` MUST NOT import
`@elizaos/plugin-personal-assistant` or `@elizaos/plugin-reminders`. The host
(PA) supplies the production deps + remains the registrar of the runner service
(`serviceType "lifeops_scheduled_task_runner"`) and the `SCHEDULED_TASKS`
action during the decomposition (runtime first-wins dedup prevents
double-registration). Tables stay in PA's `app_lifeops` and are reached via the
injected store (a later optional carve can move them to `app_scheduling`).

See `plugins/plugin-personal-assistant/docs/lifeops-extraction-plan.md` for the
full extraction sequence.

## Commands

```bash
bun run --cwd plugins/plugin-scheduling typecheck
bun run --cwd plugins/plugin-scheduling test
bun run --cwd plugins/plugin-scheduling build
```

See the root `AGENTS.md` for repo-wide architecture rules.
