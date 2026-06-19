/**
 * Calendar API contracts.
 *
 * Canonical home for the calendar event / feed / summary DTOs consumed by
 * `@elizaos/plugin-calendar` (service, action, routes, client, UI) and by
 * `@elizaos/plugin-personal-assistant` (briefs, reminders, travel) and the `@elizaos/ui`
 * client type augmentation. They live in `@elizaos/shared` because the
 * contract layer is the only package both `@elizaos/ui` and the plugins can
 * depend on without a cycle.
 *
 * The `LifeOps`-prefixed names are retained for source compatibility with the
 * many existing importers; the types are calendar-owned regardless of prefix.
 */

import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGmailMessageSummary,
} from "./personal-assistant.js";

export interface LifeOpsCalendarEventEndedFilters {
  /** Only fire for events on these calendar ids (e.g. "primary"). */
  calendarIds?: string[];
  /** Only fire when event title matches one of these case-insensitive substrings. */
  titleIncludesAny?: string[];
  /** Only fire when the event lasted at least this many minutes. */
  minDurationMinutes?: number;
  /** Only fire when one attendee email contains one of these substrings. */
  attendeeEmailIncludesAny?: string[];
}

export interface LifeOpsCalendarEventAttendee {
  email: string | null;
  displayName: string | null;
  responseStatus: string | null;
  self: boolean;
  organizer: boolean;
  optional: boolean;
}

export type LifeOpsCalendarProvider = "google" | "apple_calendar";

export interface LifeOpsCalendarEvent {
  id: string;
  externalId: string;
  agentId: string;
  provider: LifeOpsCalendarProvider;
  side: LifeOpsConnectorSide;
  calendarId: string;
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
  attendees: LifeOpsCalendarEventAttendee[];
  metadata: Record<string, unknown>;
  syncedAt: string;
  updatedAt: string;
  /** Set on merged feeds so the UI can show which calendar an event came from. */
  calendarSummary?: string;
  /** LifeOps-owned account key for privacy egress; legacy cache rows may omit it until purge/resync. */
  connectorAccountId?: string;
  /** Google grant that owns this Gmail message cache row. */
  grantId?: string;
  /** Email address for the owning Google account when known. */
  accountEmail?: string;
}

export interface LifeOpsCalendarFeed {
  calendarId: string;
  events: LifeOpsCalendarEvent[];
  source: "cache" | "synced";
  timeMin: string;
  timeMax: string;
  syncedAt: string | null;
}

/**
 * Summary of one calendar the user has access to.
 * `includeInFeed` reflects whether the user has opted this calendar into the
 * aggregated sidebar feed / briefing. Defaults to true for every calendar the
 * user can see — opt-out, never opt-in, so new calendars are not silently
 * hidden from the agent's picture of the user's life.
 */
export interface LifeOpsCalendarSummary {
  provider: LifeOpsCalendarProvider;
  side: LifeOpsConnectorSide;
  grantId: string;
  accountEmail: string | null;
  calendarId: string;
  summary: string;
  description: string | null;
  primary: boolean;
  accessRole: string;
  backgroundColor: string | null;
  foregroundColor: string | null;
  timeZone: string | null;
  selected: boolean;
  includeInFeed: boolean;
}

export interface ListLifeOpsCalendarsRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
}

export interface ListLifeOpsCalendarsResponse {
  calendars: LifeOpsCalendarSummary[];
}

export interface SetLifeOpsCalendarIncludedRequest {
  calendarId: string;
  includeInFeed: boolean;
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
}

export interface SetLifeOpsCalendarIncludedResponse {
  calendar: LifeOpsCalendarSummary;
}

export interface GetLifeOpsCalendarFeedRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  /** Target a specific Google account by grant ID (multi-account). */
  grantId?: string;
  calendarId?: string;
  /**
   * Internal/agent override: when no calendarId is specified, include every
   * authorized calendar instead of only the user's feed-enabled subset.
   */
  includeHiddenCalendars?: boolean;
  timeMin?: string;
  timeMax?: string;
  timeZone?: string;
  forceSync?: boolean;
}

export const LIFEOPS_CALENDAR_WINDOW_PRESETS = [
  "tomorrow_morning",
  "tomorrow_afternoon",
  "tomorrow_evening",
] as const;
export type LifeOpsCalendarWindowPreset =
  (typeof LIFEOPS_CALENDAR_WINDOW_PRESETS)[number];

export interface CreateLifeOpsCalendarEventAttendee {
  email: string;
  displayName?: string;
  optional?: boolean;
}

export interface CreateLifeOpsCalendarEventRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  calendarId?: string;
  grantId?: string;
  title: string;
  description?: string;
  location?: string;
  startAt?: string;
  endAt?: string;
  timeZone?: string;
  durationMinutes?: number;
  windowPreset?: LifeOpsCalendarWindowPreset;
  attendees?: CreateLifeOpsCalendarEventAttendee[];
}

export interface LifeOpsNextCalendarEventContext {
  event: LifeOpsCalendarEvent | null;
  startsAt: string | null;
  startsInMinutes: number | null;
  attendeeCount: number;
  attendeeNames: string[];
  location: string | null;
  conferenceLink: string | null;
  preparationChecklist: string[];
  linkedMailState: "unavailable" | "cache" | "synced" | "error";
  linkedMailError: string | null;
  linkedMail: Array<
    Pick<
      LifeOpsGmailMessageSummary,
      "id" | "subject" | "from" | "receivedAt" | "snippet" | "htmlLink"
    >
  >;
}

export interface LifeOpsCalendarEventUpdate {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  calendarId?: string;
  title?: string;
  startAt?: string;
  endAt?: string;
  timeZone?: string;
  notes?: string;
  location?: string;
  attendees?: CreateLifeOpsCalendarEventAttendee[];
}

export interface LifeOpsCalendarEventMutationResult {
  event: LifeOpsCalendarEvent;
}
