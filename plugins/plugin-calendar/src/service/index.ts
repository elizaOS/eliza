/** Barrel for the calendar service internals: `CalendarService`, `CalendarRepository`, the connector gate, and feed preferences. */
export {
  CalendarRepository,
  createLifeOpsCalendarSyncState,
  type LifeOpsCalendarSyncState,
} from "./CalendarRepository.js";
export {
  CalendarService,
  mergeAggregatedCalendarFeedEvents,
} from "./CalendarService.js";
export {
  type CalendarFeedPreferenceIdentifier,
  type CalendarFeedPreferences,
  calendarFeedPreferenceKey,
  ensureCalendarFeedIncludes,
  setCalendarFeedIncluded,
} from "./feed-preferences.js";
export {
  type CalendarHostGate,
  createDefaultCalendarHostGate,
  createLifeOpsAuditEvent,
  createLifeOpsReminderPlan,
} from "./gate.js";
export {
  CALENDAR_MIGRATION_SERVICE_TYPE,
  CalendarMigrationService,
  MIGRATED_CALENDAR_TABLES,
} from "./migration.js";
export {
  calendarEvents,
  calendarPgSchema,
  calendarSchema,
  calendarSyncStates,
} from "./schema.js";
