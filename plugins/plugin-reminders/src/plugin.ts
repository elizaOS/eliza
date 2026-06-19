import type { Plugin } from "@elizaos/core";
import { remindersDbSchema } from "./db/schema.ts";
import { RemindersMigrationService } from "./services/migration.ts";

/**
 * `@elizaos/plugin-reminders` — the reminder delivery/escalation data layer.
 *
 * Owns the `app_reminders` schema (reminder plans, per-channel delivery
 * attempts, escalation states) carved out of
 * `@elizaos/plugin-personal-assistant`, plus a non-destructive migration from
 * `app_lifeops`. PA auto-registers this plugin (so the schema + migration run)
 * and its reminder repository now reads/writes `app_reminders`. The
 * delivery/escalation ENGINE stays PA-resident during the decomposition,
 * writing through the carved tables.
 *
 * See `plugins/plugin-personal-assistant/docs/lifeops-extraction-plan.md`.
 */
export const remindersPlugin: Plugin = {
  name: "@elizaos/plugin-reminders",
  description:
    "Reminder delivery/escalation data layer: owns the app_reminders schema (plans, attempts, escalation states) carved out of plugin-personal-assistant, with a non-destructive migration from app_lifeops. Requires @elizaos/plugin-sql.",
  services: [RemindersMigrationService],
  schema: remindersDbSchema,
};
