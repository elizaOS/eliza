import type { LifeOpsCalendarEvent } from "../contracts/index.js";
import { GoogleApiError } from "./google-api-error.js";
import { googleApiFetch } from "./google-fetch.js";
import {
  buildUtcDateFromLocalParts,
  formatInstantAsRfc3339InTimeZone,
} from "./time.js";

const GOOGLE_CALENDAR_EVENTS_ENDPOINT =
  "https://www.googleapis.com/calendar/v3/calendars";
const GOOGLE_CALENDAR_LIST_ENDPOINT =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList";

function hasExplicitDateTimeOffset(dateTime: string): boolean {
  return /(?:[zZ]|[+-]\d{2}:\d{2})$/.test(dateTime);
}

function buildGoogleDateTimePayload(
  dateTime: string,
  timeZone: string | undefined,
): { dateTime: string; timeZone?: string } {
  if (!timeZone) {
    return { dateTime };
  }
  return {
    dateTime: hasExplicitDateTimeOffset(dateTime)
      ? formatInstantAsRfc3339InTimeZone(dateTime, timeZone)
      : dateTime,
    timeZone,
  };
}

function normalizeGoogleDateOnly(
  date: string,
  timeZone: string | undefined,
): { iso: string; timeZone: string | null } {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const effectiveTimeZone = timeZone?.trim() || "UTC";
  if (!match) {
    return {
      iso: new Date(`${date}T00:00:00.000Z`).toISOString(),
      timeZone: timeZone?.trim() || null,
    };
  }
  const localizedMidnight = buildUtcDateFromLocalParts(effectiveTimeZone, {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
    second: 0,
  });
  return {
    iso: localizedMidnight.toISOString(),
    timeZone: effectiveTimeZone,
  };
}

interface GoogleCalendarEventDate {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface GoogleCalendarApiEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  iCalUID?: string;
  recurringEventId?: string;
  created?: string;
  updated?: string;
  start?: GoogleCalendarEventDate;
  end?: GoogleCalendarEventDate;
  organizer?: {
    email?: string;
    displayName?: string;
    self?: boolean;
  };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
    organizer?: boolean;
    optional?: boolean;
  }>;
  conferenceData?: {
    entryPoints?: Array<{
      uri?: string;
      label?: string;
      entryPointType?: string;
    }>;
  };
}

interface GoogleCalendarCreateRequestBody {
  summary: string;
  description?: string;
  location?: string;
  start: {
    dateTime: string;
    // Google accepts events without timeZone when dateTime carries an explicit
    // offset, so leave it optional and let callers omit it on PATCH.
    timeZone?: string;
  };
  end: {
    dateTime: string;
    timeZone?: string;
  };
  attendees?: Array<{
    email: string;
    displayName?: string;
    optional?: boolean;
  }>;
}

export interface SyncedGoogleCalendarEvent extends Omit<
  LifeOpsCalendarEvent,
  "id" | "agentId" | "provider" | "side" | "syncedAt" | "updatedAt"
> {}

function readGoogleEventInstant(
  value: GoogleCalendarEventDate | undefined,
  fallbackTimeZone?: string,
): { iso: string; isAllDay: boolean; timeZone: string | null } | null {
  if (!value) {
    return null;
  }
  if (typeof value.dateTime === "string" && value.dateTime.trim().length > 0) {
    return {
      iso: new Date(value.dateTime).toISOString(),
      isAllDay: false,
      timeZone: value.timeZone?.trim() || null,
    };
  }
  if (typeof value.date === "string" && value.date.trim().length > 0) {
    const normalized = normalizeGoogleDateOnly(
      value.date,
      value.timeZone?.trim() || fallbackTimeZone,
    );
    return {
      iso: normalized.iso,
      isAllDay: true,
      timeZone: normalized.timeZone,
    };
  }
  return null;
}

function readConferenceLink(event: GoogleCalendarApiEvent): string | null {
  if (event.hangoutLink?.trim()) {
    return event.hangoutLink.trim();
  }
  const entryPoint = event.conferenceData?.entryPoints?.find(
    (candidate) =>
      typeof candidate.uri === "string" && candidate.uri.trim().length > 0,
  );
  return entryPoint?.uri?.trim() || null;
}

function normalizeGoogleCalendarEvent(
  calendarId: string,
  event: GoogleCalendarApiEvent,
  fallbackTimeZone?: string,
): SyncedGoogleCalendarEvent | null {
  const externalId = event.id?.trim();
  const start = readGoogleEventInstant(event.start, fallbackTimeZone);
  const end = readGoogleEventInstant(
    event.end,
    start?.timeZone ?? fallbackTimeZone,
  );
  if (!externalId || !start || !end) {
    return null;
  }

  return {
    externalId,
    calendarId,
    title: event.summary?.trim() || "Untitled event",
    description: event.description?.trim() || "",
    location: event.location?.trim() || "",
    status: event.status?.trim() || "confirmed",
    startAt: start.iso,
    endAt: end.iso,
    isAllDay: start.isAllDay,
    timezone: start.timeZone || end.timeZone,
    htmlLink: event.htmlLink?.trim() || null,
    conferenceLink: readConferenceLink(event),
    organizer: event.organizer
      ? {
          email: event.organizer.email?.trim() || null,
          displayName: event.organizer.displayName?.trim() || null,
          self: Boolean(event.organizer.self),
        }
      : null,
    attendees: (event.attendees ?? []).map((attendee) => ({
      email: attendee.email?.trim() || null,
      displayName: attendee.displayName?.trim() || null,
      responseStatus: attendee.responseStatus?.trim() || null,
      self: Boolean(attendee.self),
      organizer: Boolean(attendee.organizer),
      optional: Boolean(attendee.optional),
    })),
    metadata: {
      iCalUID: event.iCalUID?.trim() || null,
      recurringEventId: event.recurringEventId?.trim() || null,
      createdAt: event.created?.trim() || null,
    },
  };
}

async function readGoogleCalendarError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `Google Calendar request failed with ${response.status}`;
  }
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string };
    };
    return parsed.error?.message || text;
  } catch {
    return text;
  }
}

export async function fetchGoogleCalendarEvents(args: {
  accessToken: string;
  calendarId?: string;
  timeMin: string;
  timeMax: string;
  timeZone?: string;
}): Promise<SyncedGoogleCalendarEvent[]> {
  const calendarId = args.calendarId ?? "primary";
  const baseParams = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    showDeleted: "false",
    maxResults: "2500",
    timeMin: args.timeMin,
    timeMax: args.timeMax,
    fields:
      "nextPageToken,items(id,status,summary,description,location,htmlLink,hangoutLink,iCalUID,recurringEventId,created,updated,start,end,organizer(email,displayName,self),attendees(email,displayName,responseStatus,self,organizer,optional),conferenceData(entryPoints(uri,label,entryPointType)))",
  });
  if (args.timeZone?.trim()) {
    baseParams.set("timeZone", args.timeZone.trim());
  }

  const events: SyncedGoogleCalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams(baseParams);
    if (pageToken) {
      params.set("pageToken", pageToken);
    }
    const response = await googleApiFetch(
      `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${args.accessToken}`,
        },
      },
    );

    const parsed = (await response.json()) as {
      items?: GoogleCalendarApiEvent[];
      nextPageToken?: string;
    };
    for (const item of parsed.items ?? []) {
      const normalized = normalizeGoogleCalendarEvent(
        calendarId,
        item,
        args.timeZone,
      );
      if (normalized) {
        events.push(normalized);
      }
    }
    pageToken = parsed.nextPageToken?.trim() || undefined;
  } while (pageToken);
  return events;
}

export interface GoogleCalendarListEntry {
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

interface GoogleCalendarListApiEntry {
  id?: string;
  summary?: string;
  summaryOverride?: string;
  description?: string;
  primary?: boolean;
  accessRole?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  timeZone?: string;
  selected?: boolean;
  deleted?: boolean;
  hidden?: boolean;
}

export async function listGoogleCalendars(args: {
  accessToken: string;
}): Promise<GoogleCalendarListEntry[]> {
  const params = new URLSearchParams({
    minAccessRole: "reader",
    showDeleted: "false",
    showHidden: "false",
    fields:
      "items(id,summary,summaryOverride,description,primary,accessRole,backgroundColor,foregroundColor,timeZone,selected,deleted,hidden)",
  });
  const response = await googleApiFetch(
    `${GOOGLE_CALENDAR_LIST_ENDPOINT}?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
      },
    },
  );
  const parsed = (await response.json()) as {
    items?: GoogleCalendarListApiEntry[];
  };
  const entries: GoogleCalendarListEntry[] = [];
  for (const item of parsed.items ?? []) {
    if (item.deleted || item.hidden) continue;
    const calendarId = item.id?.trim();
    if (!calendarId) continue;
    const summary =
      item.summaryOverride?.trim() || item.summary?.trim() || calendarId;
    entries.push({
      calendarId,
      summary,
      description: item.description?.trim() || null,
      primary: Boolean(item.primary),
      accessRole: item.accessRole?.trim() || "reader",
      backgroundColor: item.backgroundColor?.trim() || null,
      foregroundColor: item.foregroundColor?.trim() || null,
      timeZone: item.timeZone?.trim() || null,
      selected: item.selected !== false,
    });
  }
  return entries;
}

export async function fetchGoogleCalendarEvent(args: {
  accessToken: string;
  calendarId?: string;
  eventId: string;
  timeZone?: string;
}): Promise<SyncedGoogleCalendarEvent> {
  const calendarId = args.calendarId ?? "primary";
  const response = await googleApiFetch(
    `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(args.eventId)}`,
    {
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
      },
    },
  );

  const parsed = (await response.json()) as GoogleCalendarApiEvent;
  const normalized = normalizeGoogleCalendarEvent(
    calendarId,
    parsed,
    args.timeZone,
  );
  if (!normalized) {
    throw new Error("Google Calendar get event returned an invalid payload.");
  }
  return normalized;
}

export async function createGoogleCalendarEvent(args: {
  accessToken: string;
  calendarId?: string;
  title: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  timeZone: string;
  attendees?: Array<{
    email: string;
    displayName?: string;
    optional?: boolean;
  }>;
}): Promise<SyncedGoogleCalendarEvent> {
  const calendarId = args.calendarId ?? "primary";
  const body: GoogleCalendarCreateRequestBody = {
    summary: args.title,
    start: buildGoogleDateTimePayload(args.startAt, args.timeZone),
    end: buildGoogleDateTimePayload(args.endAt, args.timeZone),
  };
  if (args.description?.trim()) {
    body.description = args.description.trim();
  }
  if (args.location?.trim()) {
    body.location = args.location.trim();
  }
  if (args.attendees && args.attendees.length > 0) {
    body.attendees = args.attendees.map((attendee) => ({
      email: attendee.email,
      ...(attendee.displayName?.trim()
        ? { displayName: attendee.displayName.trim() }
        : {}),
      ...(attendee.optional ? { optional: true } : {}),
    }));
  }

  const response = await googleApiFetch(
    `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const parsed = (await response.json()) as GoogleCalendarApiEvent;
  const normalized = normalizeGoogleCalendarEvent(
    calendarId,
    parsed,
    args.timeZone,
  );
  if (!normalized) {
    throw new Error(
      "Google Calendar create event returned an invalid payload.",
    );
  }
  return normalized;
}

export async function updateGoogleCalendarEvent(args: {
  accessToken: string;
  calendarId?: string;
  eventId: string;
  title?: string;
  description?: string;
  location?: string;
  startAt?: string;
  endAt?: string;
  timeZone?: string;
  attendees?: Array<{
    email: string;
    displayName?: string;
    optional?: boolean;
  }>;
}): Promise<SyncedGoogleCalendarEvent> {
  const calendarId = args.calendarId ?? "primary";
  // Use PATCH semantics — only the fields the caller supplies are sent, so
  // unrelated fields on the event keep their existing values.
  const body: Partial<GoogleCalendarCreateRequestBody> = {};
  if (args.title !== undefined) {
    body.summary = args.title;
  }
  if (args.description !== undefined) {
    body.description = args.description;
  }
  if (args.location !== undefined) {
    body.location = args.location;
  }
  if (args.startAt !== undefined) {
    body.start = buildGoogleDateTimePayload(args.startAt, args.timeZone);
  }
  if (args.endAt !== undefined) {
    body.end = buildGoogleDateTimePayload(args.endAt, args.timeZone);
  }
  if (args.attendees) {
    body.attendees = args.attendees.map((attendee) => ({
      email: attendee.email,
      ...(attendee.displayName?.trim()
        ? { displayName: attendee.displayName.trim() }
        : {}),
      ...(attendee.optional ? { optional: true } : {}),
    }));
  }

  const response = await googleApiFetch(
    `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(args.eventId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const parsed = (await response.json()) as GoogleCalendarApiEvent;
  const normalized = normalizeGoogleCalendarEvent(
    calendarId,
    parsed,
    args.timeZone,
  );
  if (!normalized) {
    throw new Error(
      "Google Calendar update event returned an invalid payload.",
    );
  }
  return normalized;
}

export async function deleteGoogleCalendarEvent(args: {
  accessToken: string;
  calendarId?: string;
  eventId: string;
}): Promise<void> {
  const calendarId = args.calendarId ?? "primary";
  // Google returns 204 on successful delete and 410 if the event was already
  // gone. Treat both as success — the user's intent (the event no longer
  // exists) is satisfied either way. We catch GoogleApiError(410) because
  // googleApiFetch treats 4xx as permanent failures.
  try {
    await googleApiFetch(
      `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(args.eventId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${args.accessToken}`,
        },
      },
    );
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 410) {
      return;
    }
    throw error;
  }
}
