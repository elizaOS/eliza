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
