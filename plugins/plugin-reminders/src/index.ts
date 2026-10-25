/**
 * Public entry for `@elizaos/plugin-reminders`: re-exports the `app_reminders`
 * drizzle schema, the plugin object, and the non-destructive
 * `app_lifeops`→`app_reminders` migration service.
 */
export * from "./db/schema.ts";
export { remindersPlugin } from "./plugin.ts";
export {
  MIGRATED_REMINDER_TABLES,
  type MigratedReminderTable,
  migrateReminderTable,
  migrateReminderTables,
  REMINDERS_MIGRATION_SERVICE_TYPE,
  RemindersMigrationService,
  type SqlExecutor,
  type TableMigrationResult,
} from "./services/migration.ts";
