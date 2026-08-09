/**
 * Typed Calendar read adapter over the curated official Google MCP capability.
 * It validates preview output before projecting it into the stable
 * `GoogleCalendarEvent` facade; unavailable or invalid MCP results are left for
 * `GoogleWorkspaceService` to route through its direct API fallback.
 */
import { ElizaError } from "@elizaos/core";
import type { GoogleCalendarAttendee, GoogleCalendarEvent } from "../types.js";
import type { GoogleMcpCapabilityHost } from "./capability-host.js";

interface GoogleMcpListEventsInput {
  accountId: string;
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  limit?: number;
  timeZone?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function eventInstant(value: unknown): { value?: string; isAllDay?: boolean; timeZone?: string } {
  if (!isRecord(value)) return {};
  const dateTime = optionalString(value.dateTime);
  const date = optionalString(value.date);
  const timeZone = optionalString(value.timeZone);
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
    const email = optionalString(candidate.email);
    if (!email) return [];
    return [
      {
        email,
        name: optionalString(candidate.displayName),
        responseStatus: attendeeResponseStatus(candidate.responseStatus),
        self: candidate.self === true,
        organizer: candidate.organizer === true,
        optional: candidate.optionalAttendee === true,
      },
    ];
  });
  return attendees.length > 0 ? attendees : undefined;
}

function mapEvent(
  value: unknown,
  calendarId: string,
  fallbackTimeZone?: string
): GoogleCalendarEvent {
  if (!isRecord(value)) {
    throw new ElizaError("Google Calendar MCP returned a non-object event", {
      code: "GOOGLE_MCP_CALENDAR_RESPONSE_INVALID",
    });
  }
  const id = optionalString(value.id);
  if (!id) {
    throw new ElizaError("Google Calendar MCP returned an event without an id", {
      code: "GOOGLE_MCP_CALENDAR_RESPONSE_INVALID",
      context: { calendarId },
    });
  }
  const start = eventInstant(value.start);
  const end = eventInstant(value.end);
  const organizer = isRecord(value.organizer) ? value.organizer : undefined;
  const organizerEmail = organizer ? optionalString(organizer.email) : undefined;
  const recurrence = Array.isArray(value.recurrence)
    ? value.recurrence.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return {
    id,
    calendarId,
    title: optionalString(value.summary),
    status: optionalString(value.status),
    start: start.value,
    end: end.value,
    isAllDay: start.isAllDay,
    timeZone: start.timeZone ?? end.timeZone ?? fallbackTimeZone ?? null,
    htmlLink: optionalString(value.htmlLink),
    meetLink: optionalString(value.conferenceUrl),
    attendees: mapAttendees(value.attendees),
    location: optionalString(value.location),
    description: optionalString(value.description),
    ...(organizerEmail
      ? {
          organizer: {
            email: organizerEmail,
            name: optionalString(organizer?.displayName),
            self: organizer?.self === true,
          },
        }
      : {}),
    recurrence: recurrence ?? null,
    recurringEventId: optionalString(value.recurringEventId) ?? null,
    metadata: {
      source: "google-workspace-mcp",
      createdAt: optionalString(value.created) ?? null,
      updatedAt: optionalString(value.updated) ?? null,
      eventType: optionalString(value.eventType) ?? null,
    },
  };
}

function structuredPayload(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new ElizaError("Google Calendar MCP returned no structured event payload", {
    code: "GOOGLE_MCP_CALENDAR_RESPONSE_INVALID",
  });
}

export async function listCalendarEventsViaMcp(
  host: GoogleMcpCapabilityHost,
  input: GoogleMcpListEventsInput
): Promise<GoogleCalendarEvent[] | null> {
  const events: GoogleCalendarEvent[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const execution = await host.callCapability("GOOGLE_CALENDAR_LIST_EVENTS", input.accountId, {
      ...(input.calendarId ? { calendarId: input.calendarId } : {}),
      ...(input.timeMin ? { startTime: input.timeMin } : {}),
      ...(input.timeMax ? { endTime: input.timeMax } : {}),
      ...(input.limit !== undefined ? { pageSize: Math.min(input.limit, 250) } : {}),
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      ...(pageToken ? { pageToken } : {}),
      orderBy: "startTime",
    });
    if (!execution) return null;
    if (execution.result.isError) {
      throw new ElizaError("Google Calendar MCP list_events returned a tool error", {
        code: "GOOGLE_MCP_CALENDAR_TOOL_ERROR",
        context: { accountId: input.accountId },
      });
    }
    const payload = structuredPayload(execution.result.structuredContent);
    if (!Array.isArray(payload.events)) {
      throw new ElizaError("Google Calendar MCP list_events omitted its events array", {
        code: "GOOGLE_MCP_CALENDAR_RESPONSE_INVALID",
        context: { accountId: input.accountId },
      });
    }
    const calendarId = input.calendarId ?? "primary";
    events.push(...payload.events.map((event) => mapEvent(event, calendarId, input.timeZone)));
    const nextPageToken = optionalString(payload.nextPageToken);
    if (!nextPageToken) break;
    if (seenPageTokens.has(nextPageToken)) {
      throw new ElizaError("Google Calendar MCP repeated a pagination token", {
        code: "GOOGLE_MCP_CALENDAR_PAGINATION_LOOP",
        context: { accountId: input.accountId, calendarId },
      });
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  } while (pageToken);
  return events;
}
