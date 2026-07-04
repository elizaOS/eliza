/**
 * Plugin object for the reminder delivery/escalation data layer: registers the
 * `app_reminders` schema (reminder plans, per-channel delivery attempts,
 * escalation states) and the non-destructive `app_lifeops` → `app_reminders`
 * migration service.
 *
 * PA auto-registers this plugin so the schema + migration run, and PA's reminder
 * repository reads/writes `app_reminders`. The delivery/escalation engine itself
 * stays PA-resident, writing through these tables. See
 * `plugins/plugin-personal-assistant/docs/lifeops-extraction-plan.md`.
 */
import type { Plugin } from "@elizaos/core";
import { remindersDbSchema } from "./db/schema.ts";
import { RemindersMigrationService } from "./services/migration.ts";

export const remindersPlugin: Plugin = {
  name: "@elizaos/plugin-reminders",
  description:
    "Reminder delivery/escalation data layer: owns the app_reminders schema (plans, attempts, escalation states) carved out of plugin-personal-assistant, with a non-destructive migration from app_lifeops. Requires @elizaos/plugin-sql.",
  services: [RemindersMigrationService],
  schema: remindersDbSchema,
};
