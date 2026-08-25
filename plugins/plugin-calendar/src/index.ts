/** Public entry point for `@elizaos/plugin-calendar`: the plugin definition, `CalendarService`, the `CALENDAR` action surface, and the calendar contract types host packages depend on. */
export {
  CALENDAR_DETAILS_PARAMETER_SCHEMA,
  CALENDAR_PLAN_INSTRUCTIONS,
  type CalendarActionDeps,
  type CalendarHandlerAction,
  type CalendarJsonModelResult,
  type CalendarLlmPlan,
  type CalendarModelCallArgs,
  type CalendarMutationApprovalResult,
  type CalendarMutationCancelRequest,
  type CalendarMutationGatewayDep,
  type CalendarMutationUpdateRequest,
  type CalendarSourceConnectionIntent,
  type CalendarSourceOperation,
  type CalendarTravelBufferDep,
  type CalendarTravelBufferResult,
  type CalendarTravelIntent,
  type ConflictDetectActionDeps,
  type ConflictDetectEvent,
  type ConflictDetectHostAdapter,
  type ConflictDetectLoadBatch,
  type ConflictDetectLoader,
  type ConflictDetectLoadResult,
  type ConflictDetectLoadSnapshot,
  type ConflictDetectPair,
  type ConflictDetectProposal,
  type ConflictDetectResult,
  type ConflictRange,
  type ConflictSeverity,
  calendarAction,
  calendarSourcesAction,
  conflictDetectAction,
  createCalendarActionRunner,
  createCalendarFeedConflictLoader,
  createConflictDetectAction,
  extractCalendarPlanWithLlm,
  registerConflictDetectHostAdapter,
} from "./actions/index.js";
export {
  APPLE_CALENDAR_ACCOUNT_LABEL,
  APPLE_CALENDAR_GRANT_ID,
  APPLE_CALENDAR_PROVIDER,
  isAppleCalendarEvent,
  isAppleCalendarGrant,
} from "./apple-calendar.js";
export {
  CalendarSection,
  type CalendarSectionProps,
} from "./components/CalendarSection.js";
export {
  CalendarSourceManager,
  type CalendarSourceManagerProps,
} from "./components/CalendarSourceManager.js";
export {
  type CalendarEventRow,
  type CalendarMode,
  type CalendarSnapshot,
  CalendarSpatialView,
} from "./components/calendar/CalendarSpatialView.js";
// Keep the historical public name while pointing every shipped/importable
// Calendar entry at the same month-grid implementation.
export {
  SimpleCalendarView,
  SimpleCalendarView as CalendarView,
} from "./components/calendar/SimpleCalendarView.js";
export {
  type EventEditorDefaults,
  EventEditorDrawer,
  type EventEditorDrawerProps,
  type EventEditorMode,
} from "./components/EventEditorDrawer.js";
export * from "./google-watch/index.js";
export {
  type CalendarSourceWriteOutcome,
  type UseCalendarSourcesResult,
  useCalendarSources,
} from "./hooks/useCalendarSources.js";
export {
  type CalendarViewMode,
  type UseCalendarWeekOptions,
  type UseCalendarWeekResult,
  useCalendarWeek,
} from "./hooks/useCalendarWeek.js";
export {
  ELIZA_CALENDAR_ACCOUNT_ID,
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_ID,
  ELIZA_CALENDAR_PROVIDER,
  isElizaCalendarEventId,
  isElizaCalendarGrant,
} from "./internal/eliza-calendar.js";
export { CalendarServiceError } from "./internal/errors.js";
export * from "./meetings/index.js";
export * from "./microsoft/index.js";
export { calendarPlugin, calendarPlugin as default } from "./plugin.js";
export * from "./providers/index.js";
export * from "./routes/mutation-gateway.js";
export * from "./service/index.js";
export * from "./source-administration/index.js";
