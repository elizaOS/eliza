/**
 * Shared TypeScript contract for the AppleCalendar bridge — permission,
 * calendar, event, and result shapes plus the `AppleCalendarPlugin`
 * interface — implemented identically by the native Swift bridge
 * (`ios/Sources/CalendarPlugin`) and the web fallback in `web.ts`.
 */
export type AppleCalendarPermissionState =
  | "granted"
  | "write_only"
  | "denied"
  | "prompt"
  | "restricted";

export type AppleCalendarRequestedAccess = "full_access" | "write_only";

export interface AppleCalendarPermissionStatus {
  calendar: AppleCalendarPermissionState;
  canRequest: boolean;
  reason?: string | null;
}

export interface AppleCalendarPermissionRequest {
  /**
   * Defaults to full access for compatibility. iOS versions before 17 use the
   * legacy request API, which grants full access when approved.
   */
  access?: AppleCalendarRequestedAccess;
}

export interface AppleCalendarSummary {
  calendarId: string;
  summary: string;
  description: string | null;
  primary: boolean;
  accessRole: string;
  backgroundColor: string | null;
  foregroundColor: string | null;
  timeZone: string | null;
  selected: boolean;
  sourceIdentifier: string | null;
  sourceTitle: string | null;
  sourceType: string | null;
}

export interface AppleCalendarReminder {
  relativeOffsetSeconds: number | null;
  absoluteDate: string | null;
  locationTitle: string | null;
}

export interface AppleCalendarRecurrenceRule {
  frequency: "daily" | "weekly" | "monthly" | "yearly" | "unknown";
  interval: number;
  occurrenceCount: number | null;
  endDate: string | null;
}

export interface AppleCalendarAttendee {
  email: string | null;
  displayName: string | null;
  responseStatus: string | null;
  self: boolean;
  organizer: boolean;
  optional: boolean;
}

export type AppleCalendarAvailability =
  | "not_supported"
  | "busy"
  | "free"
  | "tentative"
  | "unavailable"
  | "unknown";

export interface AppleCalendarEvent {
  id: string;
  externalId: string;
  calendarId: string;
  calendarSummary: string;
  title: string;
  description: string;
  location: string;
  status: string;
  availability: AppleCalendarAvailability;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  timezone: string | null;
  htmlLink: string | null;
  conferenceLink: string | null;
  organizer: Record<string, unknown> | null;
  attendees: AppleCalendarAttendee[];
  iCalUID: string | null;
  originalStartAt: string | null;
  lastModifiedAt: string | null;
  recurrenceRules: AppleCalendarRecurrenceRule[];
  reminders: AppleCalendarReminder[];
  sourceIdentifier: string | null;
  sourceTitle: string | null;
  sourceType: string | null;
}

export interface AppleCalendarBaseResult {
  ok: boolean;
  error?: string;
  message?: string;
}

export interface AppleCalendarListResult extends AppleCalendarBaseResult {
  calendars?: AppleCalendarSummary[];
}

export interface AppleCalendarEventsResult extends AppleCalendarBaseResult {
  events?: AppleCalendarEvent[];
}

export interface AppleCalendarEventResult extends AppleCalendarBaseResult {
  event?: AppleCalendarEvent;
}

export type AppleCalendarCreateReceipt =
  | {
      accessLevel: "write_only";
      destination: "default_calendar";
      /**
       * EventKit cannot read back even an event this app just saved under
       * write-only authorization.
       */
      eventId: null;
      readBackAvailable: false;
    }
  | {
      accessLevel: "full_access";
      destination: "resolved_calendar";
      eventId: string;
      readBackAvailable: true;
    };

export interface AppleCalendarCreateResult extends AppleCalendarEventResult {
  receipt?: AppleCalendarCreateReceipt;
}

export interface AppleCalendarListEventsOptions {
  calendarId?: string | null;
  timeMin: string;
  timeMax: string;
}

export interface AppleCalendarEventInput {
  calendarId?: string;
  title: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  timeZone?: string;
  isAllDay?: boolean;
  attendees?: Array<{
    email: string;
    displayName?: string;
    optional?: boolean;
  }>;
}

export interface AppleCalendarUpdateEventInput {
  eventId: string;
  calendarId?: string;
  title?: string;
  description?: string;
  location?: string;
  startAt?: string;
  endAt?: string;
  timeZone?: string;
  isAllDay?: boolean;
  attendees?: Array<{
    email: string;
    displayName?: string;
    optional?: boolean;
  }>;
}

export interface AppleCalendarDeleteEventInput {
  eventId: string;
}

export interface AppleCalendarPlugin {
  checkPermissions(): Promise<AppleCalendarPermissionStatus>;
  requestPermissions(
    options?: AppleCalendarPermissionRequest,
  ): Promise<AppleCalendarPermissionStatus>;
  listCalendars(): Promise<AppleCalendarListResult>;
  listEvents(
    options: AppleCalendarListEventsOptions,
  ): Promise<AppleCalendarEventsResult>;
  createEvent(
    input: AppleCalendarEventInput,
  ): Promise<AppleCalendarCreateResult>;
  updateEvent(
    input: AppleCalendarUpdateEventInput,
  ): Promise<AppleCalendarEventResult>;
  deleteEvent(
    input: AppleCalendarDeleteEventInput,
  ): Promise<AppleCalendarBaseResult>;
  addListener(
    eventName: "calendarStoreChanged",
    listener: (event: { observedAt: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}
