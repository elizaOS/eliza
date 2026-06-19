# @elizaos/plugin-reminders

The reminder delivery/escalation **data layer** for elizaOS agents — the
`app_reminders` schema carved out of `@elizaos/plugin-personal-assistant`
(LifeOps).

## Purpose / role

Owns the three reminder tables (`life_reminder_plans`, `life_reminder_attempts`,
`life_escalation_states`) under `pgSchema("app_reminders")`, plus a
non-destructive `RemindersMigrationService` that copies existing rows from
`app_lifeops` on first boot (the finances carve-out pattern). PA auto-registers
this plugin via `ensureLifeOpsRemindersPluginRegistered` so the schema +
migration run, and PA's `LifeOpsRepository` reminder SQL now reads/writes
`app_reminders`.

**Boundary:** `@elizaos/plugin-reminders` MUST NOT import
`@elizaos/plugin-personal-assistant`. During the decomposition the
delivery/escalation ENGINE (`service-mixin-reminders.ts`) stays PA-resident,
writing through the carved tables via the repointed repository — a later slice
can lift the engine here behind the `@elizaos/plugin-scheduling` tick-hook ports.

See `plugins/plugin-personal-assistant/docs/lifeops-extraction-plan.md`.

## Conventions / gotchas

- **`@elizaos/plugin-sql` must be loaded first** — the schema is registered via
  the plugin `schema` field; the SQL plugin owns the migration runner.
- Table + column names are preserved verbatim from `app_lifeops` so the copy
  migration is a straight `INSERT … SELECT`.
- The migration is non-destructive: it never drops/alters the `app_lifeops`
  source; it skips when the source is missing or the target already has data.

See the root `AGENTS.md` for repo-wide architecture rules.
