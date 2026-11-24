// spec/cloud/services/google/calendar.md, "Story: Read my calendar for a window"; spec/cloud/services/google/calendar.md, "Story: Change an event only at the revision I read"
import type { FakeAnswer, FakeHandler, FakeRequest } from "../fakes.ts";
import { bearerGrant, switched, unauthenticated, type FakeCalendar, type FakeEvent, type GoogleFakeState } from "./google.ts";

const base = "/api/calendar/v3";
const calendarScopes = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar"];
const writable: ReadonlyArray<FakeCalendar["accessRole"]> = ["writer", "owner"];
const writes = (calendar: FakeCalendar): boolean => writable.includes(calendar.accessRole ?? "reader");

const failure = (status: number, reason: string): FakeAnswer => ({ status, body: { error: { code: status, status: reason, errors: [{ reason }] } } });
const notFound = failure(404, "notFound");
const duplicate = failure(409, "duplicate");
const conditionNotMet = failure(412, "conditionNotMet");
const forbidden = failure(403, "forbidden");

let revisions = 0;

function nextEtag(): string {
  revisions += 1;
  return `"etag-${revisions}"`;
}

function calendarOf(state: GoogleFakeState, id: string): FakeCalendar | undefined {
  return id === "primary" ? [...state.calendars.values()].find((calendar) => calendar.primary === true) : state.calendars.get(id);
}

function eventKey(calendarId: string, eventId: string): string {
  return `${calendarId}/${eventId}`;
}

function shown(event: FakeEvent) {
  return { kind: "calendar#event", status: "confirmed", ...event.body, id: event.id, etag: event.etag, htmlLink: `https://calendar.example.test/event/${event.id}` };
}

function startOf(event: FakeEvent): number {
  const start = event.body.start as { readonly dateTime?: string; readonly date?: string } | undefined;
  return Date.parse(start?.dateTime ?? start?.date ?? "");
}

function endOf(event: FakeEvent): number {
  const end = event.body.end as { readonly dateTime?: string; readonly date?: string } | undefined;
  return Date.parse(end?.dateTime ?? end?.date ?? "");
}

function bodyOf(request: FakeRequest): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(request.body) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function seedCalendar(state: GoogleFakeState, calendar: FakeCalendar): void {
  state.calendars.set(calendar.id, calendar);
}

export function seedEvent(state: GoogleFakeState, calendarId: string, id: string, body: Record<string, unknown>): FakeEvent {
  const event: FakeEvent = { id, calendarId, etag: nextEtag(), body: { ...body } };
  state.events.set(eventKey(calendarId, id), event);
  return event;
}

export function touchEvent(state: GoogleFakeState, calendarId: string, id: string, change: Record<string, unknown>): string | undefined {
  const event = state.events.get(eventKey(calendarId, id));
  if (event === undefined) return undefined;
  event.body = { ...event.body, ...change };
  event.etag = nextEtag();
  return event.etag;
}

function listEntry(calendar: FakeCalendar) {
  return { kind: "calendar#calendarListEntry", id: calendar.id, summary: calendar.summary, timeZone: calendar.timeZone, ...(calendar.accessRole === undefined ? {} : { accessRole: calendar.accessRole }), ...(calendar.primary === true ? { primary: true } : {}) };
}

function calendarList(state: GoogleFakeState): FakeAnswer {
  return { status: 200, body: { kind: "calendar#calendarList", items: [...state.calendars.values()].map(listEntry) } };
}

function listEvents(state: GoogleFakeState, calendar: FakeCalendar, query: URLSearchParams): FakeAnswer {
  const from = Date.parse(query.get("timeMin") ?? "");
  const to = Date.parse(query.get("timeMax") ?? "");
  const items = [...state.events.values()]
    .filter((event) => event.calendarId === calendar.id && (Number.isNaN(to) || startOf(event) < to) && (Number.isNaN(from) || endOf(event) > from))
    .sort((left, right) => startOf(left) - startOf(right))
    .map(shown);
  return { status: 200, body: { kind: "calendar#events", timeZone: calendar.timeZone, items } };
}

function insertEvent(state: GoogleFakeState, calendar: FakeCalendar, request: FakeRequest): FakeAnswer {
  if (!writes(calendar)) return forbidden;
  const body = bodyOf(request);
  if (body === undefined || ("recurrence" in body && (!Array.isArray(body.recurrence) || !body.recurrence.every((line) => typeof line === "string")))) return failure(400, "invalid");
  const id = typeof body.id === "string" ? body.id : `generated${revisions + 1}`;
  if (state.events.has(eventKey(calendar.id, id))) return duplicate;
  const now = new Date().toISOString();
  return { status: 200, body: shown(seedEvent(state, calendar.id, id, { ...body, created: now, updated: now })) };
}

function changeEvent(state: GoogleFakeState, calendar: FakeCalendar, event: FakeEvent, request: FakeRequest): FakeAnswer {
  if (!writes(calendar)) return forbidden;
  const ifMatch = request.headers["if-match"];
  if (ifMatch !== undefined && ifMatch !== event.etag) return conditionNotMet;
  const body = bodyOf(request);
  if (body === undefined) return failure(400, "invalid");
  touchEvent(state, calendar.id, event.id, { ...body, updated: new Date().toISOString() });
  return { status: 200, body: shown(event) };
}

function deleteEvent(state: GoogleFakeState, calendar: FakeCalendar, event: FakeEvent, request: FakeRequest): FakeAnswer {
  if (!writes(calendar)) return forbidden;
  const ifMatch = request.headers["if-match"];
  if (ifMatch !== undefined && ifMatch !== event.etag) return conditionNotMet;
  for (const [key, held] of state.events) {
    if (held.calendarId === calendar.id && (held.id === event.id || held.body.recurringEventId === event.id)) state.events.delete(key);
  }
  return { status: 204 };
}

function route(state: GoogleFakeState, request: FakeRequest): FakeAnswer | undefined {
  const path = request.path.slice(base.length);
  if (path === "/users/me/calendarList" && request.method === "GET") return calendarList(state);
  const listed = /^\/users\/me\/calendarList\/([^/]+)$/.exec(path);
  if (listed !== null && request.method === "GET") {
    const calendar = calendarOf(state, decodeURIComponent(listed[1] ?? ""));
    return calendar === undefined ? notFound : { status: 200, body: listEntry(calendar) };
  }
  const match = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
  if (match === null) return undefined;
  const calendar = calendarOf(state, decodeURIComponent(match[1] ?? ""));
  if (calendar === undefined) return notFound;
  const eventId = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
  if (eventId === undefined) {
    if (request.method === "GET") return listEvents(state, calendar, request.query);
    if (request.method === "POST") return insertEvent(state, calendar, request);
    return undefined;
  }
  const event = state.events.get(eventKey(calendar.id, eventId));
  if (event === undefined) return ["GET", "PATCH", "DELETE"].includes(request.method) ? notFound : undefined;
  switch (request.method) {
    case "GET": return { status: 200, body: shown(event) };
    case "PATCH": return changeEvent(state, calendar, event, request);
    case "DELETE": return deleteEvent(state, calendar, event, request);
    default: return undefined;
  }
}

export function mountGoogleCalendar(state: GoogleFakeState): FakeHandler {
  return (request) => {
    if (!request.path.startsWith(`${base}/`)) return undefined;
    const grant = bearerGrant(state, request);
    if (grant === undefined) return unauthenticated;
    if (!grant.scopes.some((scope) => calendarScopes.includes(scope))) return forbidden;
    return switched(state, request, () => route(state, request));
  };
}
