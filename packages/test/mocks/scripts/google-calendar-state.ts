import crypto from "node:crypto";
import {
  getLifeOpsSimulatorPerson,
  LIFEOPS_SIMULATOR_CALENDAR_EVENTS,
  LIFEOPS_SIMULATOR_OWNER,
  type LifeOpsSimulatorCalendarEvent,
} from "../fixtures/lifeops-simulator.ts";
import { MockHttpError } from "./mock-http-error.ts";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type RequestBody = Record<string, JsonValue>;

interface DynamicFixtureResponse {
  statusCode: number;
  body: JsonValue;
  headers?: Record<string, string>;
}

interface GoogleCalendarEventDate {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface GoogleCalendarAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
}

interface GoogleCalendarMockCalendar {
  id: string;
  summary: string;
  description: string | null;
  primary: boolean;
  accessRole: string;
  backgroundColor: string | null;
  foregroundColor: string | null;
  timeZone: string | null;
  selected: boolean;
  deleted: boolean;
  hidden: boolean;
}

interface GoogleCalendarMockEvent {
  id: string;
  calendarId: string;
  status: string;
  summary: string;
  description: string;
  location: string;
  htmlLink: string;
  hangoutLink: string | null;
  iCalUID: string;
  recurringEventId: string | null;
  created: string;
  updated: string;
  start: GoogleCalendarEventDate;
  end: GoogleCalendarEventDate;
  organizer: {
    email: string;
    displayName: string;
    self: boolean;
  };
  attendees: GoogleCalendarAttendee[];
  deleted: boolean;
}

export interface GoogleCalendarMockState {
  calendars: Map<string, GoogleCalendarMockCalendar>;
  events: Map<string, GoogleCalendarMockEvent>;
}

export interface GoogleCalendarRequestLedgerMetadata {
  action:
    | "calendarList.list"
    | "events.list"
    | "events.get"
    | "events.create"
    | "events.patch"
    | "events.update"
    | "events.move"
    | "events.delete";
  calendarId?: string;
  destinationCalendarId?: string;
  eventId?: string;
  query?: string;
  timeMin?: string;
  timeMax?: string;
  runId?: string;
}

interface GoogleCalendarLedgerEntry {
  calendar?: GoogleCalendarRequestLedgerMetadata;
  runId?: string;
}

function simulatorEventToGoogleEvent(
  event: LifeOpsSimulatorCalendarEvent,
  now: number,
): GoogleCalendarMockEvent {
  const start = new Date(now + event.startOffsetMs);
  const end = new Date(start.getTime() + event.durationMs);
  const attendees = event.attendeePersonKeys.map((key) => {
    const person = getLifeOpsSimulatorPerson(key);
    return {
      email: person.email,
      displayName: person.name,
      responseStatus: "needsAction",
      self: false,
      organizer: false,
      optional: false,
    };
  });
  return {
    id: event.id,
    calendarId: "primary",
    status: "confirmed",
    summary: event.title,
    description: event.description,
    location: event.location,
    htmlLink: `https://calendar.google.com/calendar/event?eid=${encodeURIComponent(
      event.id,
    )}`,
    hangoutLink: "https://meet.google.com/sim-atlas",
    iCalUID: `${event.id}@lifeops-simulator.test`,
    recurringEventId: null,
    created: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    updated: new Date(now - 10 * 60 * 1000).toISOString(),
    start: {
      dateTime: start.toISOString(),
      timeZone: LIFEOPS_SIMULATOR_OWNER.timezone,
    },
    end: {
      dateTime: end.toISOString(),
      timeZone: LIFEOPS_SIMULATOR_OWNER.timezone,
    },
    organizer: {
      email: LIFEOPS_SIMULATOR_OWNER.email,
      displayName: LIFEOPS_SIMULATOR_OWNER.name,
      self: true,
    },
    attendees,
    deleted: false,
  };
}

export function createGoogleCalendarMockState(opts?: {
  simulator?: boolean;
}): GoogleCalendarMockState {
  const state: GoogleCalendarMockState = {
    calendars: new Map([
      [
        "primary",
        {
          id: "primary",
          summary: "Owner calendar",
          description: "Synthetic primary Google Calendar",
          primary: true,
          accessRole: "owner",
          backgroundColor: "#2952a3",
          foregroundColor: "#ffffff",
          timeZone: "America/Los_Angeles",
          selected: true,
          deleted: false,
          hidden: false,
        },
      ],
      [
        "work",
        {
          id: "work",
          summary: "Work calendar",
          description: "Synthetic secondary Google Calendar",
          primary: false,
          accessRole: "writer",
          backgroundColor: "#16a765",
          foregroundColor: "#ffffff",
          timeZone: "America/Los_Angeles",
          selected: false,
          deleted: false,
          hidden: false,
        },
      ],
    ]),
    events: new Map(),
  };
  if (opts?.simulator) {
    const now = Date.now();
    for (const event of LIFEOPS_SIMULATOR_CALENDAR_EVENTS) {
      const googleEvent = simulatorEventToGoogleEvent(event, now);
      state.events.set(
        eventKey(googleEvent.calendarId, googleEvent.id),
        googleEvent,
      );
    }
  }
  return state;
}

function jsonFixture(
  body: JsonValue,
  statusCode = 200,
): DynamicFixtureResponse {
  return { statusCode, body, headers: { "Content-Type": "application/json" } };
}

function jsonError(
  statusCode: number,
  message: string,
): DynamicFixtureResponse {
  const status =
    statusCode === 401
      ? "UNAUTHENTICATED"
      : statusCode === 403
        ? "PERMISSION_DENIED"
        : statusCode === 404
          ? "NOT_FOUND"
          : statusCode === 410
            ? "GONE"
            : "INVALID_ARGUMENT";
  return jsonFixture(
    {
      error: {
        code: statusCode,
        message,
        status,
      },
    },
    statusCode,
  );
}

function calendarResponse(
  calendar: GoogleCalendarMockCalendar,
): Record<string, JsonValue> {
  return {
    kind: "calendar#calendarListEntry",
    id: calendar.id,
    summary: calendar.summary,
    ...(calendar.description ? { description: calendar.description } : {}),
    primary: calendar.primary,
    accessRole: calendar.accessRole,
    ...(calendar.backgroundColor
      ? { backgroundColor: calendar.backgroundColor }
      : {}),
    ...(calendar.foregroundColor
      ? { foregroundColor: calendar.foregroundColor }
      : {}),
    ...(calendar.timeZone ? { timeZone: calendar.timeZone } : {}),
    selected: calendar.selected,
    ...(calendar.deleted ? { deleted: true } : {}),
    ...(calendar.hidden ? { hidden: true } : {}),
  };
}

function eventKey(calendarId: string, eventId: string): string {
  return `${calendarId}\u0000${eventId}`;
}

function eventResponse(
  event: GoogleCalendarMockEvent,
): Record<string, JsonValue> {
  return {
    kind: "calendar#event",
    id: event.id,
    status: event.status,
    htmlLink: event.htmlLink,
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: { ...event.start },
    end: { ...event.end },
    organizer: { ...event.organizer },
    attendees: event.attendees.map((attendee) => ({ ...attendee })),
    iCalUID: event.iCalUID,
    created: event.created,
    updated: event.updated,
    ...(event.hangoutLink ? { hangoutLink: event.hangoutLink } : {}),
    ...(event.recurringEventId
      ? { recurringEventId: event.recurringEventId }
      : {}),
  };
}

function decodeRouteParam(value: string | undefined): string {
  return decodeURIComponent(value ?? "");
}

function matchEventsPath(
  pathname: string,
): { calendarId: string; eventId?: string; move: boolean } | null {
  const match =
    /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?(?:\/(move))?\/?$/.exec(
      pathname,
    );
  if (!match) return null;
  return {
    calendarId: decodeRouteParam(match[1]),
    ...(match[2] ? { eventId: decodeRouteParam(match[2]) } : {}),
    move: match[3] === "move",
  };
}

function requireCalendar(
  state: GoogleCalendarMockState,
  calendarId: string,
): GoogleCalendarMockCalendar | DynamicFixtureResponse {
  const calendar = state.calendars.get(calendarId);
  return calendar && !calendar.deleted
    ? calendar
    : jsonError(404, "Calendar not found.");
}

function getEvent(
  state: GoogleCalendarMockState,
  calendarId: string,
  eventId: string,
): GoogleCalendarMockEvent | null {
  return state.events.get(eventKey(calendarId, eventId)) ?? null;
}

function requiredEventResponse(
  state: GoogleCalendarMockState,
  calendarId: string,
  eventId: string,
): GoogleCalendarMockEvent | DynamicFixtureResponse {
  const event = getEvent(state, calendarId, eventId);
  if (!event) return jsonError(404, "Requested entity was not found.");
  return event.deleted
    ? jsonError(410, "Requested entity was deleted.")
    : event;
}

function asRecord(value: JsonValue | undefined, key: string): RequestBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MockHttpError(400, `${key} must be an object`);
  }
  return value as RequestBody;
}

function optionalString(value: JsonValue | undefined, key: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new MockHttpError(400, `${key} must be a string`);
  }
  return value.trim();
}

function requireEventDate(
  value: JsonValue | undefined,
  key: string,
): GoogleCalendarEventDate {
  const record = asRecord(value, key);
  const date = optionalString(record.date, `${key}.date`);
  const dateTime = optionalString(record.dateTime, `${key}.dateTime`);
  const timeZone = optionalString(record.timeZone, `${key}.timeZone`);
  if (!date && !dateTime) {
    throw new MockHttpError(400, `${key} must include date or dateTime`);
  }
  if (dateTime && Number.isNaN(Date.parse(dateTime))) {
    throw new MockHttpError(400, `${key}.dateTime must be an ISO date-time`);
  }
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new MockHttpError(400, `${key}.date must be YYYY-MM-DD`);
  }
  return {
    ...(date ? { date } : {}),
    ...(dateTime ? { dateTime } : {}),
    ...(timeZone ? { timeZone } : {}),
  };
}

function readAttendees(value: JsonValue | undefined): GoogleCalendarAttendee[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new MockHttpError(400, "attendees must be an array");
  }
  return value.map((entry, index) => {
    const attendee = asRecord(entry, `attendees[${index}]`);
    const email = optionalString(attendee.email, `attendees[${index}].email`);
    if (!email) {
      throw new MockHttpError(
        400,
        `attendees[${index}].email must be a non-empty string`,
      );
    }
    return {
      email,
      ...(optionalString(
        attendee.displayName,
        `attendees[${index}].displayName`,
      )
        ? {
            displayName: optionalString(
              attendee.displayName,
              `attendees[${index}].displayName`,
            ),
          }
        : {}),
      responseStatus: "needsAction",
      optional: attendee.optional === true,
    };
  });
}

function eventStartMs(event: GoogleCalendarMockEvent): number {
  if (event.start.dateTime) return Date.parse(event.start.dateTime);
  return Date.parse(`${event.start.date ?? ""}T00:00:00.000Z`);
}

function eventEndMs(event: GoogleCalendarMockEvent): number {
  if (event.end.dateTime) return Date.parse(event.end.dateTime);
  return Date.parse(`${event.end.date ?? ""}T00:00:00.000Z`);
}

function optionalBoundaryMs(
  params: URLSearchParams,
  key: "timeMin" | "timeMax",
): number | null {
  const value = params.get(key);
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new MockHttpError(400, `${key} must be an ISO date-time`);
  }
  return parsed;
}

function eventMatchesQuery(
  event: GoogleCalendarMockEvent,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const haystack = [
    event.id,
    event.summary,
    event.description,
    event.location,
    event.organizer.email,
    event.organizer.displayName,
    ...event.attendees.flatMap((attendee) => [
      attendee.email ?? "",
      attendee.displayName ?? "",
    ]),
  ]
    .join(" ")
    .toLowerCase();
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function listEvents(
  state: GoogleCalendarMockState,
  calendarId: string,
  searchParams: URLSearchParams,
): DynamicFixtureResponse {
  const calendar = requireCalendar(state, calendarId);
  if ("statusCode" in calendar) return calendar;

  const timeMin = optionalBoundaryMs(searchParams, "timeMin");
  const timeMax = optionalBoundaryMs(searchParams, "timeMax");
  const query = searchParams.get("q") ?? "";
  const showDeleted = searchParams.get("showDeleted") === "true";
  const maxResults = Math.max(
    1,
    Math.min(Number.parseInt(searchParams.get("maxResults") ?? "50", 10), 250),
  );
  const pageOffset = Math.max(
    0,
    Number.parseInt(searchParams.get("pageToken") ?? "0", 10) || 0,
  );
  const matching = [...state.events.values()]
    .filter((event) => event.calendarId === calendarId)
    .filter((event) => showDeleted || !event.deleted)
    .filter((event) => {
      const startMs = eventStartMs(event);
      const endMs = eventEndMs(event);
      if (timeMin !== null && endMs < timeMin) return false;
      if (timeMax !== null && startMs > timeMax) return false;
      return eventMatchesQuery(event, query);
    })
    .sort((left, right) => eventStartMs(left) - eventStartMs(right));
  const page = matching.slice(pageOffset, pageOffset + maxResults);
  return jsonFixture({
    kind: "calendar#events",
    summary: calendar.summary,
    updated: new Date().toISOString(),
    timeZone: calendar.timeZone ?? "UTC",
    accessRole: calendar.accessRole,
    items: page.map((event) => eventResponse(event)),
    ...(pageOffset + maxResults < matching.length
      ? { nextPageToken: String(pageOffset + maxResults) }
      : {}),
  });
}

function buildEvent(
  calendarId: string,
  body: RequestBody,
): GoogleCalendarMockEvent {
  const now = new Date().toISOString();
  const id = `evt-${crypto.randomUUID()}`;
  const summary = optionalString(body.summary, "summary") || "Untitled event";
  return {
    id,
    calendarId,
    status: "confirmed",
    summary,
    description: optionalString(body.description, "description"),
    location: optionalString(body.location, "location"),
    htmlLink: `https://calendar.google.com/event?eid=${encodeURIComponent(id)}`,
    hangoutLink: null,
    iCalUID: `${id}@mock.calendar.google.com`,
    recurringEventId: null,
    created: now,
    updated: now,
    start: requireEventDate(body.start, "start"),
    end: requireEventDate(body.end, "end"),
    organizer: {
      email: "owner@example.test",
      displayName: "Owner",
      self: true,
    },
    attendees: readAttendees(body.attendees),
    deleted: false,
  };
}

function applyEventPatch(
  event: GoogleCalendarMockEvent,
  body: RequestBody,
  requireBounds: boolean,
): void {
  if (requireBounds && (!body.start || !body.end)) {
    throw new MockHttpError(400, "update requires start and end");
  }
  if (body.summary !== undefined) {
    event.summary = optionalString(body.summary, "summary") || "Untitled event";
  }
  if (body.description !== undefined) {
    event.description = optionalString(body.description, "description");
  }
  if (body.location !== undefined) {
    event.location = optionalString(body.location, "location");
  }
  if (body.start !== undefined) {
    event.start = requireEventDate(body.start, "start");
  }
  if (body.end !== undefined) {
    event.end = requireEventDate(body.end, "end");
  }
  if (body.attendees !== undefined) {
    event.attendees = readAttendees(body.attendees);
  }
  event.updated = new Date().toISOString();
}

function createEvent(
  state: GoogleCalendarMockState,
  calendarId: string,
  requestBody: RequestBody,
): DynamicFixtureResponse {
  const calendar = requireCalendar(state, calendarId);
  if ("statusCode" in calendar) return calendar;
  const event = buildEvent(calendarId, requestBody);
  state.events.set(eventKey(calendarId, event.id), event);
  return jsonFixture(eventResponse(event));
}

function mutateEvent(
  state: GoogleCalendarMockState,
  calendarId: string,
  eventId: string,
  requestBody: RequestBody,
  action: "patch" | "update",
): DynamicFixtureResponse {
  const event = requiredEventResponse(state, calendarId, eventId);
  if ("statusCode" in event) return event;
  applyEventPatch(event, requestBody, action === "update");
  return jsonFixture(eventResponse(event));
}

function moveEvent(
  state: GoogleCalendarMockState,
  calendarId: string,
  eventId: string,
  searchParams: URLSearchParams,
): DynamicFixtureResponse {
  const event = requiredEventResponse(state, calendarId, eventId);
  if ("statusCode" in event) return event;
  const destination = searchParams.get("destination")?.trim();
  if (!destination) {
    throw new MockHttpError(400, "destination must be a non-empty string");
  }
  const destinationCalendar = requireCalendar(state, destination);
  if ("statusCode" in destinationCalendar) return destinationCalendar;

  state.events.delete(eventKey(calendarId, eventId));
  event.calendarId = destination;
  event.updated = new Date().toISOString();
  state.events.set(eventKey(destination, eventId), event);
  return jsonFixture(eventResponse(event));
}

function deleteEvent(
  state: GoogleCalendarMockState,
  calendarId: string,
  eventId: string,
): DynamicFixtureResponse {
  const event = getEvent(state, calendarId, eventId);
  if (!event) return jsonError(404, "Requested entity was not found.");
  if (event.deleted) return jsonError(410, "Requested entity was deleted.");
  event.deleted = true;
  event.status = "cancelled";
  event.updated = new Date().toISOString();
  return { statusCode: 204, body: null };
}

function recordCalendarLedger(
  ledgerEntry: GoogleCalendarLedgerEntry,
  metadata: GoogleCalendarRequestLedgerMetadata,
): void {
  ledgerEntry.calendar = {
    ...metadata,
    ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
  };
}

export function googleCalendarDynamicFixture(args: {
  state: GoogleCalendarMockState;
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  requestBody: RequestBody;
  ledgerEntry: GoogleCalendarLedgerEntry;
}): DynamicFixtureResponse | null {
  if (
    args.method === "GET" &&
    args.pathname === "/calendar/v3/users/me/calendarList"
  ) {
    recordCalendarLedger(args.ledgerEntry, { action: "calendarList.list" });
    const calendars = [...args.state.calendars.values()].filter(
      (calendar) =>
        !calendar.deleted &&
        !calendar.hidden &&
        calendar.accessRole !== "freeBusyReader",
    );
    return jsonFixture({
      kind: "calendar#calendarList",
      items: calendars.map((calendar) => calendarResponse(calendar)),
    });
  }

  const eventPath = matchEventsPath(args.pathname);
  if (!eventPath) return null;

  const query = args.searchParams.get("q") ?? undefined;
  const timeMin = args.searchParams.get("timeMin") ?? undefined;
  const timeMax = args.searchParams.get("timeMax") ?? undefined;

  if (args.method === "GET" && !eventPath.eventId) {
    recordCalendarLedger(args.ledgerEntry, {
      action: "events.list",
      calendarId: eventPath.calendarId,
      ...(query ? { query } : {}),
      ...(timeMin ? { timeMin } : {}),
      ...(timeMax ? { timeMax } : {}),
    });
    return listEvents(args.state, eventPath.calendarId, args.searchParams);
  }

  if (args.method === "POST" && !eventPath.eventId) {
    recordCalendarLedger(args.ledgerEntry, {
      action: "events.create",
      calendarId: eventPath.calendarId,
    });
    return createEvent(args.state, eventPath.calendarId, args.requestBody);
  }

  if (!eventPath.eventId) return null;

  if (args.method === "GET") {
    recordCalendarLedger(args.ledgerEntry, {
      action: "events.get",
      calendarId: eventPath.calendarId,
      eventId: eventPath.eventId,
    });
    const event = requiredEventResponse(
      args.state,
      eventPath.calendarId,
      eventPath.eventId,
    );
    return "statusCode" in event ? event : jsonFixture(eventResponse(event));
  }

  if (args.method === "PATCH") {
    recordCalendarLedger(args.ledgerEntry, {
      action: "events.patch",
      calendarId: eventPath.calendarId,
      eventId: eventPath.eventId,
    });
    return mutateEvent(
      args.state,
      eventPath.calendarId,
      eventPath.eventId,
      args.requestBody,
      "patch",
    );
  }

  if (args.method === "PUT") {
    recordCalendarLedger(args.ledgerEntry, {
      action: "events.update",
      calendarId: eventPath.calendarId,
      eventId: eventPath.eventId,
    });
    return mutateEvent(
      args.state,
      eventPath.calendarId,
      eventPath.eventId,
      args.requestBody,
      "update",
    );
  }

  if (args.method === "POST" && eventPath.move) {
    const destination = args.searchParams.get("destination")?.trim();
    recordCalendarLedger(args.ledgerEntry, {
      action: "events.move",
      calendarId: eventPath.calendarId,
      eventId: eventPath.eventId,
      ...(destination ? { destinationCalendarId: destination } : {}),
    });
    return moveEvent(
      args.state,
      eventPath.calendarId,
      eventPath.eventId,
      args.searchParams,
    );
  }

  if (args.method === "DELETE") {
    recordCalendarLedger(args.ledgerEntry, {
      action: "events.delete",
      calendarId: eventPath.calendarId,
      eventId: eventPath.eventId,
    });
    return deleteEvent(args.state, eventPath.calendarId, eventPath.eventId);
  }

  return null;
}
