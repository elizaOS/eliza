/** Renderer entry: Calendar views and HTTP client without provider or runtime code. */
export {
  type CalendarClientMethods,
  createCalendarApi,
  installCalendarClient,
} from "./api/client-calendar.js";
export {
  CalendarSection,
  type CalendarSectionProps,
} from "./components/CalendarSection.js";
export {
  CalendarSourceManager,
  type CalendarSourceManagerProps,
} from "./components/CalendarSourceManager.js";
export {
  CalendarWorkspace,
  type CalendarWorkspaceProps,
  type CalendarWorkspaceState,
  type CalendarWorkspaceStatus,
} from "./components/CalendarWorkspace.js";
export {
  CalendarPage,
  CalendarPage as CalendarView,
} from "./components/calendar/CalendarPage.js";
export { CalendarSpatialView } from "./components/calendar/CalendarSpatialView.js";
export { SimpleCalendarView } from "./components/calendar/SimpleCalendarView.js";
export { EventEditorDrawer } from "./components/EventEditorDrawer.js";
export { registerCalendarApp } from "./register.js";
