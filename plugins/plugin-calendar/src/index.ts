/** Public entry point for `@elizaos/plugin-calendar`: the plugin definition, `CalendarService`, the `CALENDAR` action surface, and the calendar contract types host packages depend on. */
export {
  CALENDAR_PLAN_INSTRUCTIONS,
  type CalendarActionDeps,
  type CalendarHandlerAction,
  type CalendarJsonModelResult,
  type CalendarLlmPlan,
  type CalendarModelCallArgs,
  type CalendarTravelBufferDep,
  type CalendarTravelBufferResult,
  type CalendarTravelIntent,
  createCalendarActionRunner,
  extractCalendarPlanWithLlm,
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
  type CalendarEventRow,
  type CalendarMode,
  type CalendarSnapshot,
  CalendarSpatialView,
} from "./components/calendar/CalendarSpatialView.js";
export { CalendarView } from "./components/calendar/CalendarView.js";
export {
  type EventEditorDefaults,
  EventEditorDrawer,
  type EventEditorDrawerProps,
  type EventEditorMode,
} from "./components/EventEditorDrawer.js";
export {
  type CalendarViewMode,
  type UseCalendarWeekOptions,
  type UseCalendarWeekResult,
  useCalendarWeek,
} from "./hooks/useCalendarWeek.js";
export { CalendarServiceError } from "./internal/errors.js";
export * from "./meetings/index.js";
export { calendarPlugin, calendarPlugin as default } from "./plugin.js";
export {
  registerCalendarTerminalView,
  setCalendarTerminalSnapshot,
} from "./register-terminal-view.js";
export * from "./service/index.js";

// Side-effect: DOM-guarded terminal-view registration for the Node agent host.
import "./register.js";
