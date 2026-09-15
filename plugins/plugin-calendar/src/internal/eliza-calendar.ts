/**
 * Built-in Eliza calendar identity and event mapping. The provider persists in
 * the canonical calendar repository, so a new agent has one writable source
 * without an external account while retaining the same feed, approval, audit,
 * reminder, and optimistic-concurrency contracts as connected providers.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarSummary,
} from "@elizaos/shared";
import { CalendarServiceError } from "./errors.js";

export const ELIZA_CALENDAR_PROVIDER = "eliza" as const;
export const ELIZA_CALENDAR_GRANT_ID = "eliza-calendar" as const;
export const ELIZA_CALENDAR_ACCOUNT_ID = "eliza-calendar" as const;
export const ELIZA_CALENDAR_ID = "primary" as const;

function calendarEtag(revision: number): string {
  return `"eliza-${revision}"`;
}

function calendarRevision(event: LifeOpsCalendarEvent): number {
  const revision = event.metadata.version;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
    throw new CalendarServiceError(
      500,
      "The built-in calendar event has an invalid version.",
      "ELIZA_CALENDAR_VERSION_INVALID",
    );
  }
  return Number(revision);
}

function eventExternalId(agentId: string, idempotencyKey?: string): string {
  const operationKey = idempotencyKey?.trim();
  if (!operationKey) return `event-${randomUUID()}`;
  const digest = createHash("sha256")
    .update(`${agentId}\u0000${operationKey}`)
    .digest("hex");
  return `event-${digest}`;
}

function eventId(agentId: string, externalId: string): string {
  return [
    agentId,
    ELIZA_CALENDAR_PROVIDER,
    "owner",
    "grant",
    ELIZA_CALENDAR_GRANT_ID,
    "calendar",
    ELIZA_CALENDAR_ID,
    externalId,
  ].join(":");
}

function eventAttendees(
  attendees: readonly CreateLifeOpsCalendarEventAttendee[],
): LifeOpsCalendarEvent["attendees"] {
  return attendees.map((attendee) => ({
    email: attendee.email,
    displayName: attendee.displayName ?? null,
    responseStatus: null,
    self: false,
    organizer: false,
    optional: attendee.optional === true,
  }));
}

export function isElizaCalendarGrant(
  grantId: string | null | undefined,
): boolean {
  return grantId === ELIZA_CALENDAR_GRANT_ID;
}

export function isElizaCalendarEventId(
  value: string | null | undefined,
  agentId: string,
): boolean {
  return Boolean(
    value?.startsWith(`${agentId}:${ELIZA_CALENDAR_PROVIDER}:owner:grant:`),
  );
}

export function elizaCalendarSummary(
  timeZone: string | null = null,
): LifeOpsCalendarSummary {
  return {
    provider: ELIZA_CALENDAR_PROVIDER,
    side: "owner",
    grantId: ELIZA_CALENDAR_GRANT_ID,
    connectorAccountId: ELIZA_CALENDAR_ACCOUNT_ID,
    accountEmail: null,
    calendarId: ELIZA_CALENDAR_ID,
    summary: "Eliza Calendar",
    description: "Built-in calendar stored with this Eliza agent.",
    primary: true,
    accessRole: "owner",
    backgroundColor: null,
    foregroundColor: null,
    timeZone,
    selected: true,
    includeInFeed: true,
    selectionVersion: 0,
  };
}

export function createElizaCalendarEvent(args: {
  agentId: string;
  request: CreateLifeOpsCalendarEventRequest;
  startAt: string;
  endAt: string;
  timeZone: string;
  isAllDay: boolean;
  attendees: readonly CreateLifeOpsCalendarEventAttendee[];
  now: Date;
}): LifeOpsCalendarEvent {
  const title = args.request.title.trim();
  if (!title) {
    throw new CalendarServiceError(
      400,
      "Calendar event title is required.",
      "CALENDAR_EVENT_TITLE_REQUIRED",
    );
  }
  if (
    args.request.calendarId &&
    args.request.calendarId !== ELIZA_CALENDAR_ID
  ) {
    throw new CalendarServiceError(
      404,
      "The built-in Eliza calendar has one primary calendar.",
      "ELIZA_CALENDAR_NOT_FOUND",
    );
  }
  if (args.request.notifyAttendees === true) {
    throw new CalendarServiceError(
      400,
      "The built-in Eliza calendar cannot email attendees. Connect an external calendar to send invitations.",
      "ELIZA_CALENDAR_ATTENDEE_NOTIFICATIONS_UNSUPPORTED",
    );
  }
  if (args.request.recurrence?.length) {
    throw new CalendarServiceError(
      400,
      "Recurring events require a connected calendar provider.",
      "ELIZA_CALENDAR_RECURRENCE_UNSUPPORTED",
    );
  }
  const externalId = eventExternalId(args.agentId, args.request.idempotencyKey);
  const timestamp = args.now.toISOString();
  return {
    id: eventId(args.agentId, externalId),
    externalId,
    agentId: args.agentId,
    provider: ELIZA_CALENDAR_PROVIDER,
    side: "owner",
    calendarId: ELIZA_CALENDAR_ID,
    title,
    description: args.request.description?.trim() ?? "",
    location: args.request.location?.trim() ?? "",
    status: "confirmed",
    startAt: args.startAt,
    endAt: args.endAt,
    isAllDay: args.isAllDay,
    timezone: args.timeZone,
    htmlLink: null,
    conferenceLink: null,
    organizer: { self: true, displayName: "You" },
    attendees: eventAttendees(args.attendees),
    metadata: {
      managedBy: ELIZA_CALENDAR_PROVIDER,
      version: 1,
      etag: calendarEtag(1),
    },
    syncedAt: timestamp,
    updatedAt: timestamp,
    connectorAccountId: ELIZA_CALENDAR_ACCOUNT_ID,
    grantId: ELIZA_CALENDAR_GRANT_ID,
  };
}

export function updateElizaCalendarEvent(args: {
  event: LifeOpsCalendarEvent;
  title?: string;
  description?: string;
  location?: string;
  startAt?: string;
  endAt?: string;
  timeZone?: string;
  isAllDay?: boolean;
  attendees?: readonly CreateLifeOpsCalendarEventAttendee[];
  now: Date;
}): LifeOpsCalendarEvent {
  if (args.event.provider !== ELIZA_CALENDAR_PROVIDER) {
    throw new CalendarServiceError(
      409,
      "The event is not owned by the built-in Eliza calendar.",
      "ELIZA_CALENDAR_EVENT_PROVIDER_MISMATCH",
    );
  }
  const title = args.title === undefined ? args.event.title : args.title.trim();
  if (!title) {
    throw new CalendarServiceError(
      400,
      "Calendar event title is required.",
      "CALENDAR_EVENT_TITLE_REQUIRED",
    );
  }
  const startAt = args.startAt ?? args.event.startAt;
  const endAt = args.endAt ?? args.event.endAt;
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new CalendarServiceError(
      400,
      "Calendar event times must be valid ISO date-times.",
      "CALENDAR_EVENT_TIME_INVALID",
    );
  }
  if (endMs <= startMs) {
    throw new CalendarServiceError(
      400,
      "endAt must be later than startAt",
      "CALENDAR_EVENT_RANGE_INVALID",
    );
  }
  const revision = calendarRevision(args.event) + 1;
  const timestamp = args.now.toISOString();
  return {
    ...args.event,
    title,
    description: args.description?.trim() ?? args.event.description,
    location: args.location?.trim() ?? args.event.location,
    startAt,
    endAt,
    timezone: args.timeZone ?? args.event.timezone,
    isAllDay: args.isAllDay ?? args.event.isAllDay,
    attendees:
      args.attendees === undefined
        ? args.event.attendees
        : eventAttendees(args.attendees),
    metadata: {
      ...args.event.metadata,
      managedBy: ELIZA_CALENDAR_PROVIDER,
      version: revision,
      etag: calendarEtag(revision),
    },
    syncedAt: timestamp,
    updatedAt: timestamp,
  };
}
