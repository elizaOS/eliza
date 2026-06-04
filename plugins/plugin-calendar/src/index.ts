export { calendarPlugin, calendarPlugin as default } from "./plugin.js";
export * from "./service/index.js";
export {
  APPLE_CALENDAR_ACCOUNT_LABEL,
  APPLE_CALENDAR_GRANT_ID,
  APPLE_CALENDAR_PROVIDER,
  isAppleCalendarEvent,
  isAppleCalendarGrant,
} from "./apple-calendar.js";
export { CalendarServiceError } from "./internal/errors.js";
