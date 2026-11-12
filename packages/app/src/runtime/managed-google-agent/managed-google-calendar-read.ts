/** Browser-safe decoders for the Eliza Cloud managed Calendar wire format. */
import type {
  GoogleCalendarFeed,
  GoogleCalendarSummary,
} from "../../../../../plugins/plugin-calendar/src/linked-sync/google-reader.ts";

type InvalidResponse = () => Error;

function object(
  value: unknown,
  invalidResponse: InvalidResponse,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidResponse();
  return value as Record<string, unknown>;
}
function string(value: unknown, invalidResponse: InvalidResponse): string {
  if (typeof value !== "string" || !value.trim()) throw invalidResponse();
  return value;
}
function optionalString(
  value: unknown,
  invalidResponse: InvalidResponse,
): string | null {
  return value == null ? null : string(value, invalidResponse);
}
function timestamp(value: unknown, invalidResponse: InvalidResponse): number {
  const parsed = Date.parse(string(value, invalidResponse));
  if (!Number.isFinite(parsed)) throw invalidResponse();
  return parsed;
}

export function parseManagedGoogleCalendars(
  data: unknown,
  invalidResponse: InvalidResponse,
): GoogleCalendarSummary[] {
  if (!Array.isArray(data)) throw invalidResponse();
  const seen = new Set<string>();
  return data.map((value) => {
    const row = object(value, invalidResponse),
      calendarId = string(row.calendarId, invalidResponse);
    if (
      seen.has(calendarId) ||
      typeof row.primary !== "boolean" ||
      typeof row.selected !== "boolean"
    )
      throw invalidResponse();
    seen.add(calendarId);
    return {
      calendarId,
      summary: string(row.summary, invalidResponse),
      description: optionalString(row.description, invalidResponse),
      primary: row.primary,
      accessRole: string(row.accessRole, invalidResponse),
      backgroundColor: optionalString(row.backgroundColor, invalidResponse),
      foregroundColor: optionalString(row.foregroundColor, invalidResponse),
      timeZone: optionalString(row.timeZone, invalidResponse),
      selected: row.selected,
    };
  });
}

export function parseManagedGoogleCalendarFeed(
  value: unknown,
  calendarId: string,
  invalidResponse: InvalidResponse,
): GoogleCalendarFeed {
  const data = object(value, invalidResponse);
  if (
    data.calendarId !== calendarId ||
    !Array.isArray(data.events) ||
    data.nextPageToken != null ||
    data.truncated === true
  )
    throw invalidResponse();
  timestamp(data.syncedAt, invalidResponse);
  const plain = (value: unknown) => {
    if (typeof value !== "string") throw invalidResponse();
    return value;
  };
  const flag = (value: unknown) => {
    if (typeof value !== "boolean") throw invalidResponse();
    return value;
  };
  const seen = new Set<string>();
  const events = data.events.map((value) => {
    const row = object(value, invalidResponse),
      externalId = string(row.externalId, invalidResponse);
    if (
      row.calendarId !== calendarId ||
      seen.has(externalId) ||
      !Array.isArray(row.attendees) ||
      timestamp(row.endAt, invalidResponse) <
        timestamp(row.startAt, invalidResponse)
    )
      throw invalidResponse();
    seen.add(externalId);
    return {
      externalId,
      calendarId,
      title: plain(row.title),
      description: plain(row.description),
      location: plain(row.location),
      status: string(row.status, invalidResponse),
      startAt: string(row.startAt, invalidResponse),
      endAt: string(row.endAt, invalidResponse),
      isAllDay: flag(row.isAllDay),
      timezone: optionalString(row.timezone, invalidResponse),
      htmlLink: optionalString(row.htmlLink, invalidResponse),
      conferenceLink: optionalString(row.conferenceLink, invalidResponse),
      organizer:
        row.organizer == null ? null : object(row.organizer, invalidResponse),
      metadata: object(row.metadata, invalidResponse),
      attendees: row.attendees.map((value) => {
        const a = object(value, invalidResponse);
        return {
          email: optionalString(a.email, invalidResponse),
          displayName: optionalString(a.displayName, invalidResponse),
          responseStatus: optionalString(a.responseStatus, invalidResponse),
          self: flag(a.self),
          organizer: flag(a.organizer),
          optional: flag(a.optional),
        };
      }),
    };
  });
  return {
    calendarId,
    events,
    syncedAt: string(data.syncedAt, invalidResponse),
  };
}
