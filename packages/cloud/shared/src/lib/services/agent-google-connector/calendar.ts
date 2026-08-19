/**
 * Coordinates managed Google Calendar reads and mutations behind cloud route
 * handlers, including compatible IANA local-time normalization at the service
 * boundary.
 */
import { applyTimeZone } from "../../utils/google-mcp-shared";
import type { OAuthConnectionRole } from "../oauth/types";
import {
  fail,
  googleFetch,
  type ManagedGoogleCalendarEvent,
  type ManagedGoogleCalendarSummary,
} from "./shared";

const GOOGLE_CALENDAR_EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars";
const GOOGLE_CALENDAR_LIST_ENDPOINT =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList";
// Bounds the feed loop against a provider (or misbehaving proxy) that repeats
// or never stops minting a nextPageToken -- 1,000 pages * 2,500/page covers
// even a very dense calendar while keeping worst-case requests/memory finite.
const MAX_GOOGLE_CALENDAR_FEED_PAGES = 1_000;

type GoogleCalendarEventDate = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

type GoogleCalendarApiEvent = {
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
    }>;
  };
};

type GoogleCalendarListApiEntry = {
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
};

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const OFFSET_SAMPLE_HOURS = [-48, -36, -24, -12, 0, 12, 24, 36, 48];

function getZonedDateParts(date: Date, timeZone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) {
      throw new Error(`missing zoned date part: ${type}`);
    }
    return Number(value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const token = parts.find((part) => part.type === "timeZoneName")?.value?.trim() ?? "GMT";
  if (token === "GMT" || token === "UTC") {
    return 0;
  }
  const match = token.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) {
    throw new Error(`unsupported offset token: ${token}`);
  }
  const sign = match[1] === "+" ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? "0"));
}

function localPartsToEpochMs(parts: LocalDateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function sameZonedParts(left: LocalDateTimeParts, right: LocalDateTimeParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

/**
 * Resolves local calendar parts with Temporal-compatible disambiguation.
 */
export function buildUtcDateFromLocalParts(timeZone: string, parts: LocalDateTimeParts): Date {
  const baseUtcMs = localPartsToEpochMs(parts);
  const offsets = new Set(
    OFFSET_SAMPLE_HOURS.map((hours) =>
      getTimeZoneOffsetMinutes(new Date(baseUtcMs + hours * HOUR_MS), timeZone),
    ),
  );
  const candidates = [...offsets].map(
    (offsetMinutes) => new Date(baseUtcMs - offsetMinutes * MINUTE_MS),
  );
  const exact = candidates
    .filter((candidate) => sameZonedParts(getZonedDateParts(candidate, timeZone), parts))
    .sort((left, right) => left.getTime() - right.getTime());
  if (exact[0]) {
    // Compatible disambiguation selects the earlier instant during a repeat.
    return exact[0];
  }

  const shiftedForward = candidates
    .map((candidate) => ({
      candidate,
      wallDeltaMs: localPartsToEpochMs(getZonedDateParts(candidate, timeZone)) - baseUtcMs,
    }))
    .filter(({ wallDeltaMs }) => wallDeltaMs > 0)
    .sort(
      (left, right) =>
        left.wallDeltaMs - right.wallDeltaMs ||
        left.candidate.getTime() - right.candidate.getTime(),
    );
  if (shiftedForward[0]) {
    // Compatible disambiguation advances a nonexistent wall time by the gap,
    // including jurisdictions that skip an entire local calendar date.
    return shiftedForward[0].candidate;
  }

  throw new RangeError(`Local date-time cannot be resolved in timezone ${timeZone}`);
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

function readGoogleEventInstant(
  value: GoogleCalendarEventDate | undefined,
  fallbackTimeZone?: string,
): { iso: string; isAllDay: boolean; timeZone: string | null } | null {
  if (!value) return null;
  if (value.dateTime?.trim()) {
    return {
      iso: new Date(value.dateTime).toISOString(),
      isAllDay: false,
      timeZone: value.timeZone?.trim() || null,
    };
  }
  if (value.date?.trim()) {
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
  return event.conferenceData?.entryPoints?.find((entry) => entry.uri?.trim())?.uri?.trim() || null;
}

function normalizeGoogleCalendarEvent(
  calendarId: string,
  event: GoogleCalendarApiEvent,
  fallbackTimeZone?: string,
): ManagedGoogleCalendarEvent | null {
  const externalId = event.id?.trim();
  const start = readGoogleEventInstant(event.start, fallbackTimeZone);
  const end = readGoogleEventInstant(event.end, start?.timeZone ?? fallbackTimeZone);
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

export async function fetchManagedGoogleCalendarFeed(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  calendarId: string;
  timeMin: string;
  timeMax: string;
  timeZone: string;
}): Promise<{
  calendarId: string;
  events: ManagedGoogleCalendarEvent[];
  syncedAt: string;
}> {
  const baseParams = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    showDeleted: "false",
    maxResults: "2500",
    timeMin: args.timeMin,
    timeMax: args.timeMax,
    fields:
      "nextPageToken,items(id,status,summary,description,location,htmlLink,hangoutLink,iCalUID,recurringEventId,created,start,end,organizer(email,displayName,self),attendees(email,displayName,responseStatus,self,organizer,optional),conferenceData(entryPoints(uri)))",
    timeZone: args.timeZone,
  });

  const events: ManagedGoogleCalendarEvent[] = [];
  let pageToken: string | undefined;
  let pageCount = 0;
  const seenPageTokens = new Set<string>();
  do {
    pageCount += 1;
    if (pageCount > MAX_GOOGLE_CALENDAR_FEED_PAGES) {
      fail(
        502,
        `Google Calendar feed pagination exceeded ${MAX_GOOGLE_CALENDAR_FEED_PAGES} pages.`,
      );
    }
    const params = new URLSearchParams(baseParams);
    if (pageToken) {
      params.set("pageToken", pageToken);
    }
    const response = await googleFetch({
      organizationId: args.organizationId,
      userId: args.userId,
      side: args.side,
      grantId: args.grantId,
      url: `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(args.calendarId)}/events?${params.toString()}`,
    });
    const parsed = (await response.json()) as {
      items?: GoogleCalendarApiEvent[];
      nextPageToken?: string;
    };
    events.push(
      ...(parsed.items ?? [])
        .map((event) => normalizeGoogleCalendarEvent(args.calendarId, event, args.timeZone))
        .filter((event): event is ManagedGoogleCalendarEvent => event !== null),
    );
    const nextPageToken = parsed.nextPageToken?.trim() || undefined;
    if (nextPageToken && seenPageTokens.has(nextPageToken)) {
      fail(502, "Google Calendar feed pagination repeated a page token.");
    }
    if (nextPageToken) {
      seenPageTokens.add(nextPageToken);
    }
    pageToken = nextPageToken;
  } while (pageToken);

  return {
    calendarId: args.calendarId,
    events,
    syncedAt: new Date().toISOString(),
  };
}

export async function listManagedGoogleCalendars(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
}): Promise<ManagedGoogleCalendarSummary[]> {
  const params = new URLSearchParams({
    minAccessRole: "reader",
    showDeleted: "false",
    showHidden: "false",
    fields:
      "items(id,summary,summaryOverride,description,primary,accessRole,backgroundColor,foregroundColor,timeZone,selected,deleted,hidden)",
  });

  const response = await googleFetch({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
    url: `${GOOGLE_CALENDAR_LIST_ENDPOINT}?${params.toString()}`,
  });
  const parsed = (await response.json()) as {
    items?: GoogleCalendarListApiEntry[];
  };

  const calendars: ManagedGoogleCalendarSummary[] = [];
  for (const item of parsed.items ?? []) {
    if (item.deleted || item.hidden) continue;
    const calendarId = item.id?.trim();
    if (!calendarId) continue;
    calendars.push({
      calendarId,
      summary: item.summaryOverride?.trim() || item.summary?.trim() || calendarId,
      description: item.description?.trim() || null,
      primary: Boolean(item.primary),
      accessRole: item.accessRole?.trim() || "reader",
      backgroundColor: item.backgroundColor?.trim() || null,
      foregroundColor: item.foregroundColor?.trim() || null,
      timeZone: item.timeZone?.trim() || null,
      selected: item.selected !== false,
    });
  }

  return calendars;
}

export async function createManagedGoogleCalendarEvent(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  calendarId: string;
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
}): Promise<{ event: ManagedGoogleCalendarEvent }> {
  const response = await googleFetch({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
    url: `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(args.calendarId)}/events?conferenceDataVersion=1`,
    options: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: args.title,
        description: args.description ?? "",
        location: args.location ?? "",
        start: applyTimeZone(args.startAt, args.timeZone),
        end: applyTimeZone(args.endAt, args.timeZone),
        attendees: args.attendees ?? [],
      }),
    },
  });
  const parsed = (await response.json()) as GoogleCalendarApiEvent;
  const event = normalizeGoogleCalendarEvent(args.calendarId, parsed, args.timeZone);
  if (!event) {
    fail(502, "Google Calendar returned a partial event payload.");
  }
  return { event };
}

function normalizeManagedCalendarDateTimeInTimeZone(
  value: string | undefined,
  field: string,
  timeZone: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = value.trim();
  if (!text) {
    fail(400, `${field} is required.`);
  }
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(text)) {
    const parsed = new Date(text);
    if (!Number.isFinite(parsed.getTime())) {
      fail(400, `${field} must be a valid datetime.`);
    }
    return parsed.toISOString();
  }

  const localMatch = text.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/,
  );
  if (localMatch) {
    if (!timeZone) {
      fail(
        400,
        `${field} must include a timezone or UTC offset when no event timezone is available.`,
      );
    }
    const localized = buildUtcDateFromLocalParts(timeZone, {
      year: Number(localMatch[1]),
      month: Number(localMatch[2]),
      day: Number(localMatch[3]),
      hour: Number(localMatch[4] ?? "0"),
      minute: Number(localMatch[5] ?? "0"),
      second: Number(localMatch[6] ?? "0"),
    });
    localized.setUTCMilliseconds(Number((localMatch[7] ?? "0").padEnd(3, "0")));
    return localized.toISOString();
  }

  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) {
    fail(400, `${field} must be a valid datetime.`);
  }
  return parsed.toISOString();
}

async function fetchManagedGoogleCalendarEvent(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  calendarId: string;
  eventId: string;
  fallbackTimeZone?: string;
}): Promise<ManagedGoogleCalendarEvent | null> {
  const params = new URLSearchParams({
    fields:
      "id,status,summary,description,location,htmlLink,hangoutLink,iCalUID,recurringEventId,created,start,end,organizer(email,displayName,self),attendees(email,displayName,responseStatus,self,organizer,optional),conferenceData(entryPoints(uri))",
  });
  const response = await googleFetch({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
    url: `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.eventId)}?${params.toString()}`,
  });
  const parsed = (await response.json()) as GoogleCalendarApiEvent;
  return normalizeGoogleCalendarEvent(args.calendarId, parsed, args.fallbackTimeZone);
}

export async function updateManagedGoogleCalendarEvent(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  calendarId: string;
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
}): Promise<{ event: ManagedGoogleCalendarEvent }> {
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const needsExistingEventContext =
    Boolean(args.startAt || args.endAt) && (!args.timeZone || !args.startAt || !args.endAt);
  const existingEvent = needsExistingEventContext
    ? await fetchManagedGoogleCalendarEvent({
        organizationId: args.organizationId,
        userId: args.userId,
        side: args.side,
        grantId: args.grantId,
        calendarId: args.calendarId,
        eventId: args.eventId,
        fallbackTimeZone: args.timeZone,
      })
    : null;
  const effectiveTimeZone = args.timeZone ?? existingEvent?.timezone ?? undefined;
  let normalizedStartAt = normalizeManagedCalendarDateTimeInTimeZone(
    args.startAt,
    "startAt",
    effectiveTimeZone,
  );
  let normalizedEndAt = normalizeManagedCalendarDateTimeInTimeZone(
    args.endAt,
    "endAt",
    effectiveTimeZone,
  );
  const existingDurationMs =
    existingEvent &&
    Number.isFinite(Date.parse(existingEvent.startAt)) &&
    Number.isFinite(Date.parse(existingEvent.endAt))
      ? Date.parse(existingEvent.endAt) - Date.parse(existingEvent.startAt)
      : Number.NaN;
  const fallbackDurationMs =
    Number.isFinite(existingDurationMs) && existingDurationMs > 0
      ? existingDurationMs
      : ONE_HOUR_MS;
  if (normalizedStartAt && !normalizedEndAt) {
    normalizedEndAt = new Date(
      new Date(normalizedStartAt).getTime() + fallbackDurationMs,
    ).toISOString();
  } else if (normalizedEndAt && !normalizedStartAt) {
    normalizedStartAt = new Date(
      new Date(normalizedEndAt).getTime() - fallbackDurationMs,
    ).toISOString();
  }

  const response = await googleFetch({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
    url: `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.eventId)}?conferenceDataVersion=1`,
    options: {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(args.title !== undefined ? { summary: args.title } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.location !== undefined ? { location: args.location } : {}),
        ...(normalizedStartAt
          ? { start: applyTimeZone(normalizedStartAt, effectiveTimeZone) }
          : {}),
        ...(normalizedEndAt ? { end: applyTimeZone(normalizedEndAt, effectiveTimeZone) } : {}),
        ...(args.attendees !== undefined ? { attendees: args.attendees } : {}),
      }),
    },
  });
  const parsed = (await response.json()) as GoogleCalendarApiEvent;
  const event = normalizeGoogleCalendarEvent(args.calendarId, parsed, effectiveTimeZone);
  if (!event) {
    fail(502, "Google Calendar returned a partial event payload.");
  }
  return { event };
}

export async function deleteManagedGoogleCalendarEvent(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  calendarId: string;
  eventId: string;
}): Promise<{ ok: true }> {
  await googleFetch({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
    url: `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.eventId)}`,
    options: {
      method: "DELETE",
    },
  });
  return { ok: true };
}
