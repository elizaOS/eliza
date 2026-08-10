/**
 * Projects a raw official Google Calendar MCP event payload into the stable
 * `GoogleCalendarEvent` facade. Invalid preview output fails closed; there is
 * no personal-Google REST fallback.
 */
import { ElizaError } from "@elizaos/core";
import type { GoogleCalendarAttendee, GoogleCalendarEvent } from "../types.js";
import { isRecord, optionalRawString } from "../values.js";

function eventInstant(value: unknown): { value?: string; isAllDay?: boolean; timeZone?: string } {
  if (!isRecord(value)) return {};
  const dateTime = optionalRawString(value.dateTime);
  const date = optionalRawString(value.date);
  const timeZone = optionalRawString(value.timeZone);
  return {
    ...(dateTime || date ? { value: dateTime ?? date } : {}),
    ...(date ? { isAllDay: true } : dateTime ? { isAllDay: false } : {}),
    ...(timeZone ? { timeZone } : {}),
  };
}

function attendeeResponseStatus(value: unknown): GoogleCalendarAttendee["responseStatus"] {
  if (typeof value !== "string") return null;
  switch (value.toLowerCase().replaceAll("_", "")) {
    case "needsaction":
      return "needsAction";
    case "declined":
      return "declined";
    case "tentative":
      return "tentative";
    case "accepted":
      return "accepted";
    default:
      return null;
  }
}

function mapAttendees(value: unknown): GoogleCalendarAttendee[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attendees = value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const email = optionalRawString(candidate.email);
    if (!email) return [];
    return [
      {
        email,
        name: optionalRawString(candidate.displayName),
        responseStatus: attendeeResponseStatus(candidate.responseStatus),
        self: candidate.self === true,
        organizer: candidate.organizer === true,
        optional: candidate.optionalAttendee === true,
      },
    ];
  });
  return attendees.length > 0 ? attendees : undefined;
}

export function googleCalendarEventFromMcp(
  value: unknown,
  calendarId: string,
  fallbackTimeZone?: string
): GoogleCalendarEvent {
  if (!isRecord(value)) {
    throw new ElizaError("Google Calendar MCP returned a non-object event", {
      code: "GOOGLE_MCP_CALENDAR_RESPONSE_INVALID",
    });
  }
  const id = optionalRawString(value.id);
  if (!id) {
    throw new ElizaError("Google Calendar MCP returned an event without an id", {
      code: "GOOGLE_MCP_CALENDAR_RESPONSE_INVALID",
      context: { calendarId },
    });
  }
  const start = eventInstant(value.start);
  const end = eventInstant(value.end);
  const organizer = isRecord(value.organizer) ? value.organizer : undefined;
  const organizerEmail = organizer ? optionalRawString(organizer.email) : undefined;
  const recurrence = Array.isArray(value.recurrence)
    ? value.recurrence.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const availability = optionalRawString(value.availability);
  const visibility = optionalRawString(value.visibility);
  return {
    id,
    calendarId,
    title: optionalRawString(value.summary),
    status: optionalRawString(value.status),
    start: start.value,
    end: end.value,
    isAllDay: start.isAllDay,
    timeZone: start.timeZone ?? end.timeZone ?? fallbackTimeZone ?? null,
    htmlLink: optionalRawString(value.htmlLink),
    meetLink: optionalRawString(value.conferenceUrl),
    attendees: mapAttendees(value.attendees),
    location: optionalRawString(value.location),
    description: optionalRawString(value.description),
    ...(organizerEmail
      ? {
          organizer: {
            email: organizerEmail,
            name: optionalRawString(organizer?.displayName),
            self: organizer?.self === true,
          },
        }
      : {}),
    recurrence: recurrence ?? null,
    recurringEventId: optionalRawString(value.recurringEventId) ?? null,
    transparency:
      availability === "AVAILABILITY_FREE" ? "transparent" : availability ? "opaque" : undefined,
    visibility:
      visibility === "default" ||
      visibility === "public" ||
      visibility === "private" ||
      visibility === "confidential"
        ? visibility
        : undefined,
    metadata: {
      source: "google-workspace-mcp",
      createdAt: optionalRawString(value.created) ?? null,
      updatedAt: optionalRawString(value.updated) ?? null,
      eventType: optionalRawString(value.eventType) ?? null,
    },
  };
}
