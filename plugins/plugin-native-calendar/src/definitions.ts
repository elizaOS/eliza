export type AppleCalendarPermissionState =
  | "granted"
  | "denied"
  | "prompt"
  | "restricted";

export interface AppleCalendarPermissionStatus {
  calendar: AppleCalendarPermissionState;
  canRequest: boolean;
  reason?: string | null;
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
}

export interface AppleCalendarAttendee {
  email: string | null;
  displayName: string | null;
  responseStatus: string | null;
  self: boolean;
  organizer: boolean;
  optional: boolean;
}

export interface AppleCalendarEvent {
  id: string;
  externalId: string;
  calendarId: string;
  calendarSummary: string;
  title: string;
  description: string;
  location: string;
  status: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  timezone: string | null;
  htmlLink: string | null;
  conferenceLink: string | null;
  organizer: Record<string, unknown> | null;
  attendees: AppleCalendarAttendee[];
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

export interface AppleCalendarListEventsOptions {
  calendarId?: string | null;
  timeMin: string;
  timeMax: string;
}

export interface AppleCalendarEventInput {
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

export interface AppleCalendarUpdateEventInput extends AppleCalendarEventInput {
  eventId: string;
}

export interface AppleCalendarDeleteEventInput {
  eventId: string;
}

export interface AppleCalendarPlugin {
  checkPermissions(): Promise<AppleCalendarPermissionStatus>;
  requestPermissions(): Promise<AppleCalendarPermissionStatus>;
  listCalendars(): Promise<AppleCalendarListResult>;
  listEvents(
    options: AppleCalendarListEventsOptions,
  ): Promise<AppleCalendarEventsResult>;
  createEvent(
    input: AppleCalendarEventInput,
  ): Promise<AppleCalendarEventResult>;
  updateEvent(
    input: AppleCalendarUpdateEventInput,
  ): Promise<AppleCalendarEventResult>;
  deleteEvent(
    input: AppleCalendarDeleteEventInput,
  ): Promise<AppleCalendarBaseResult>;
}
