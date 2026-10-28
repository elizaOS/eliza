/** Stateless owner Calendar sync: stable creates, conditional writes, bounded provider I/O. */

import type {
  LinkedCalendarProviderSnapshot,
  LinkedCalendarSemanticEvent,
} from "@elizaos/contracts/calendar-linked-sync";
import { z } from "zod";
import { boundedProviderFetch } from "../../utils/bounded-provider-fetch";
import { NO_FOLLOW_REDIRECT, withoutRedirects } from "../../utils/no-redirect-fetch";

export interface CalendarSyncOwner {
  organizationId: string;
  userId: string;
  grantId: string;
  /** Expected Google identity for event requests; discovered from capabilities. */
  accountId?: string;
  signal?: AbortSignal;
}
export interface CalendarSyncGrant {
  connectionId: string;
  accountId: string;
  accountEmail?: string;
  token: string;
  capabilities: readonly string[];
}
export interface CalendarSyncDependencies {
  grant(owner: CalendarSyncOwner, write: boolean): Promise<CalendarSyncGrant>;
  current(owner: CalendarSyncOwner): Promise<Omit<CalendarSyncGrant, "token">>;
  request?: typeof fetch;
}
type Session = { owner: CalendarSyncOwner; grant: CalendarSyncGrant; identity: string };
export type CalendarSyncEvent = LinkedCalendarSemanticEvent;
export interface CalendarSyncSnapshot extends LinkedCalendarProviderSnapshot {
  visibility: "private" | "public" | "default";
  remindersDisabled: boolean;
}
type Json = Record<string, unknown>;
const record = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);
const atom = (value: unknown, max = 2048): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);
const endpoint = "https://www.googleapis.com/calendar/v3";
const providerBytesLimit = 256 * 1024;
const eventSchema = z
  .object({
    title: z.string().trim().min(1).max(4000),
    description: z.string().max(64000),
    location: z.string().max(4096),
    startAt: z.string().max(64),
    endAt: z.string().max(64),
    timeZone: z.string().max(128).nullable(),
    isAllDay: z.boolean(),
    attendees: z
      .array(
        z.object({ email: z.string().email().max(320), optional: z.boolean().optional() }).strict(),
      )
      .max(100),
    deleted: z.literal(false).optional(),
    recurrence: z.array(z.string().min(1).max(2048)).max(100).optional(),
  })
  .strict();
export class CalendarSyncError extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 412 | 413 | 429 | 502 | 503,
    readonly code: string,
    readonly outcome: "not_accepted" | "precondition_failed" | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "CalendarSyncError";
  }
}
const reject = (message: string) =>
  new CalendarSyncError(400, "CALENDAR_SYNC_INVALID", "not_accepted", message);
async function digest(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
function eventInput(value: unknown): CalendarSyncEvent {
  const parsed = eventSchema.safeParse(value);
  if (!parsed.success) throw reject("Review the complete Calendar event before syncing.");
  const event = parsed.data;
  if (event.isAllDay) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(event.startAt) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(event.endAt) ||
      event.timeZone !== null
    )
      throw reject("All-day events need whole dates.");
  } else {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(event.startAt) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(event.endAt)
    )
      throw reject("Timed events need absolute RFC3339 instants.");
    if (!event.timeZone) throw reject("Timed events need a timezone.");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: event.timeZone }).format();
    } catch {
      throw reject("Review the event timezone.");
    }
  }
  const start = Date.parse(event.startAt),
    end = Date.parse(event.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw reject("Review the event dates.");
  if (
    event.isAllDay &&
    (new Date(start).toISOString().slice(0, 10) !== event.startAt ||
      new Date(end).toISOString().slice(0, 10) !== event.endAt)
  )
    throw reject("Review valid all-day dates.");
  return {
    ...event,
    ...(!event.isAllDay
      ? { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() }
      : {}),
    attendees: event.attendees
      .map((a) => ({ email: a.email.toLowerCase(), optional: a.optional === true }))
      .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0)),
  };
}
function googleBody(event: CalendarSyncEvent) {
  return {
    summary: event.title,
    description: event.description,
    location: event.location,
    start: event.isAllDay
      ? { date: event.startAt }
      : { dateTime: event.startAt, timeZone: event.timeZone },
    end: event.isAllDay
      ? { date: event.endAt }
      : { dateTime: event.endAt, timeZone: event.timeZone },
    attendees: event.attendees,
    recurrence: event.recurrence ? [...event.recurrence] : [],
  };
}
/** Google recommends get+update: preserve every unedited provider field under the exact ETag. */
function replacement(previous: Json, before: CalendarSyncEvent, event: CalendarSyncEvent): Json {
  if (previous.attendeesOmitted === true)
    throw new CalendarSyncError(
      409,
      "CALENDAR_SYNC_INCOMPLETE_ATTENDEES",
      "not_accepted",
      "Google did not return the complete guest list. Nothing was changed.",
    );
  const next: Json = { ...previous },
    body = googleBody(event);
  if (event.title !== before.title) next.summary = event.title;
  if (event.description !== before.description) next.description = event.description;
  if (event.location !== before.location) next.location = event.location;
  if (event.isAllDay !== before.isAllDay || event.timeZone !== before.timeZone) {
    next.start = body.start;
    next.end = body.end;
  } else {
    if (event.startAt !== before.startAt)
      next.start = {
        ...objectDate(previous.start),
        ...(event.isAllDay ? { date: event.startAt } : { dateTime: event.startAt }),
      };
    if (event.endAt !== before.endAt)
      next.end = {
        ...objectDate(previous.end),
        ...(event.isAllDay ? { date: event.endAt } : { dateTime: event.endAt }),
      };
  }
  if (JSON.stringify(event.recurrence || []) !== JSON.stringify(before.recurrence || []))
    next.recurrence = body.recurrence;
  if (JSON.stringify(event.attendees) !== JSON.stringify(before.attendees)) {
    const old = new Map<string, Json>();
    for (const value of Array.isArray(previous.attendees) ? previous.attendees : []) {
      if (!record(value) || typeof value.email !== "string")
        throw reject("Review the complete Google guest list.");
      const key = value.email.toLowerCase();
      if (old.has(key)) throw reject("Google returned ambiguous duplicate guests.");
      old.set(key, value);
    }
    next.attendees = event.attendees.map((attendee) => ({
      ...old.get(attendee.email),
      email: attendee.email,
      optional: attendee.optional === true,
    }));
  }
  return next;
}
function objectDate(value: unknown): Json {
  if (!record(value)) throw reject("Review the Google event dates.");
  return value;
}
function snapshot(raw: Json): CalendarSyncSnapshot {
  if (!atom(raw.id) || !atom(raw.etag) || !record(raw.start) || !record(raw.end))
    throw new CalendarSyncError(
      502,
      "CALENDAR_SYNC_BAD_EVENT",
      "unknown",
      "Google returned an incomplete Calendar event.",
    );
  const allDay = typeof raw.start.date === "string",
    attendees = raw.attendees ?? [];
  if (!Array.isArray(attendees) || attendees.some((a) => !record(a) || typeof a.email !== "string"))
    throw new CalendarSyncError(
      502,
      "CALENDAR_SYNC_BAD_EVENT",
      "unknown",
      "Google returned invalid attendees.",
    );
  let event: CalendarSyncEvent;
  try {
    event = eventInput({
      title: typeof raw.summary === "string" ? raw.summary : "",
      description: typeof raw.description === "string" ? raw.description : "",
      location: typeof raw.location === "string" ? raw.location : "",
      startAt: allDay ? raw.start.date : raw.start.dateTime,
      endAt: allDay ? raw.end.date : raw.end.dateTime,
      timeZone: allDay ? null : (raw.start.timeZone ?? raw.end.timeZone ?? null),
      isAllDay: allDay,
      attendees: attendees.map((a) => ({
        email: (a as Json).email,
        optional: (a as Json).optional === true,
      })),
      ...(Array.isArray(raw.recurrence) && raw.recurrence.length
        ? { recurrence: raw.recurrence }
        : {}),
    });
  } catch (error) {
    if (error instanceof CalendarSyncError && error.code === "CALENDAR_SYNC_INVALID")
      throw new CalendarSyncError(
        502,
        "CALENDAR_SYNC_BAD_EVENT",
        "unknown",
        "Google returned an event that cannot be represented by this sync contract.",
      );
    throw error;
  }
  return {
    eventId: raw.id,
    etag: raw.etag,
    event,
    visibility:
      raw.visibility === "private" ? "private" : raw.visibility === "public" ? "public" : "default",
    remindersDisabled:
      record(raw.reminders) &&
      raw.reminders.useDefault === false &&
      (!Array.isArray(raw.reminders.overrides) || raw.reminders.overrides.length === 0),
  };
}
/**
 * Google echoes attendees it adds itself (the organizer's own entry, booked resources).
 * Compare only guests the request controls, so an applied create is not misread as changed.
 */
function requestedView(
  raw: Json,
  saved: CalendarSyncEvent,
  requested: CalendarSyncEvent,
): CalendarSyncEvent {
  const asked = new Set(requested.attendees.map((attendee) => attendee.email)),
    added = new Set(
      (Array.isArray(raw.attendees) ? raw.attendees : [])
        .filter(
          (a): a is Json =>
            record(a) &&
            typeof a.email === "string" &&
            (a.organizer === true || a.self === true || a.resource === true),
        )
        .map((a) => String(a.email).toLowerCase()),
    );
  return {
    ...saved,
    attendees: saved.attendees.filter(
      (attendee) => asked.has(attendee.email) || !added.has(attendee.email),
    ),
  };
}
function etag(value: string) {
  if (!atom(value, 1024) || value === "*")
    throw reject("An exact Google event revision is required.");
  return value;
}
function providerFailure(status: number) {
  return new CalendarSyncError(
    status === 412 ? 412 : status === 429 ? 429 : status < 500 ? 409 : 502,
    status === 412 ? "CALENDAR_SYNC_PRECONDITION" : "CALENDAR_SYNC_PROVIDER_REJECTED",
    status === 412
      ? "precondition_failed"
      : [400, 401, 403, 404, 409, 410, 422, 429].includes(status)
        ? "not_accepted"
        : "unknown",
    "Google did not confirm this Calendar change. Refresh its exact event and receipt before retrying.",
  );
}

export class ManagedCalendarSyncProvider {
  constructor(private readonly dependencies: CalendarSyncDependencies) {}
  private async session(
    owner: CalendarSyncOwner,
    mode: "discover" | "read" | "write",
  ): Promise<Session> {
    owner = { ...owner };
    if (mode !== "discover" && !atom(owner.accountId))
      throw reject("An exact Google account precondition is required.");
    const grant = await this.dependencies.grant(owner, mode === "write");
    if (
      grant.connectionId !== owner.grantId ||
      !grant.token ||
      !atom(grant.accountId) ||
      !grant.capabilities.includes("google.calendar.read") ||
      (mode === "write" && !grant.capabilities.includes("google.calendar.write")) ||
      (mode !== "discover" && owner.accountId !== grant.accountId)
    )
      throw new CalendarSyncError(
        403,
        "CALENDAR_SYNC_PERMISSION",
        "not_accepted",
        "The selected Calendar permission is unavailable.",
      );
    const captured = { ...grant, capabilities: [...grant.capabilities] };
    return {
      owner,
      grant: captured,
      identity: JSON.stringify([
        captured.connectionId,
        captured.accountId,
        [...captured.capabilities].sort(),
      ]),
    };
  }
  private async current(scope: Session) {
    scope.owner.signal?.throwIfAborted();
    const latest = await this.dependencies.current(scope.owner);
    if (
      JSON.stringify([latest.connectionId, latest.accountId, [...latest.capabilities].sort()]) !==
      scope.identity
    )
      throw new CalendarSyncError(
        409,
        "CALENDAR_SYNC_GRANT_CHANGED",
        "unknown",
        "The selected Google account or permissions changed. Check its event before retrying.",
      );
    scope.owner.signal?.throwIfAborted();
  }
  private calendar(id: string) {
    if (!atom(id, 1024)) throw reject("Select an exact Calendar.");
    return `${endpoint}/calendars/${encodeURIComponent(id)}/events`;
  }
  private async call(
    scope: Session,
    url: string,
    method = "GET",
    body?: object,
    expectedEtag?: string,
  ): Promise<{ status: number; data: Json | null }> {
    await this.current(scope);
    if (method !== "GET" && !scope.grant.capabilities.includes("google.calendar.write"))
      throw new CalendarSyncError(
        403,
        "CALENDAR_SYNC_PERMISSION",
        "not_accepted",
        "Calendar write permission is unavailable.",
      );
    const encoded = body ? JSON.stringify(body) : undefined;
    if (encoded !== undefined && new TextEncoder().encode(encoded).length > providerBytesLimit)
      throw new CalendarSyncError(
        413,
        "CALENDAR_SYNC_TOO_LARGE",
        "not_accepted",
        "The complete Calendar update exceeds the provider request budget. No fields were dropped and nothing was changed.",
      );
    let status: number,
      data: Json | null = null;
    try {
      const response = await boundedProviderFetch(
        url,
        {
          method,
          redirect: NO_FOLLOW_REDIRECT,
          signal: scope.owner.signal,
          headers: {
            Authorization: `Bearer ${scope.grant.token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(expectedEtag ? { "If-Match": etag(expectedEtag) } : {}),
          },
          ...(encoded === undefined ? {} : { body: encoded }),
        },
        {
          provider: "google-calendar-sync",
          timeoutMs: 30000,
          maxResponseBytes: providerBytesLimit,
          // A 3xx rejects like the former redirect: "error" (workerd refuses
          // that mode), so it lands on the outcome-unknown path below.
          fetchImpl: withoutRedirects(this.dependencies.request),
        },
      );
      status = response.status;
      if (response.ok && status !== 204) {
        const parsed: unknown = await response.json();
        if (!record(parsed)) throw Error("Invalid provider response");
        data = parsed;
      } else await response.body?.cancel();
    } catch {
      throw new CalendarSyncError(
        502,
        "CALENDAR_SYNC_OUTCOME_UNKNOWN",
        "unknown",
        "The Calendar request outcome could not be confirmed. Do not repeat a write until its event is checked.",
      );
    }
    try {
      await this.current(scope);
    } catch {
      throw new CalendarSyncError(
        409,
        "CALENDAR_SYNC_GRANT_CHANGED",
        "unknown",
        "The Calendar connection changed while the request was running. Check its event before retrying.",
      );
    }
    return { status, data };
  }
  private async access(scope: Session, calendarId: string, write = false) {
    this.calendar(calendarId);
    const result = await this.call(
      scope,
      `${endpoint}/users/me/calendarList/${encodeURIComponent(calendarId)}`,
    );
    if (
      result.status !== 200 ||
      !result.data ||
      (result.data.id !== calendarId &&
        !(calendarId === "primary" && result.data.primary === true)) ||
      !["reader", "writer", "owner"].includes(String(result.data.accessRole)) ||
      (write && !["writer", "owner"].includes(String(result.data.accessRole)))
    )
      throw new CalendarSyncError(
        403,
        "CALENDAR_SYNC_CALENDAR_UNAVAILABLE",
        "not_accepted",
        "The selected Calendar is unavailable or its permissions changed.",
      );
    return result.data;
  }
  async capabilities(owner: CalendarSyncOwner, calendarId: string) {
    this.calendar(calendarId);
    const scope = await this.session(owner, "discover"),
      calendar = await this.access(scope, calendarId),
      grant = scope.grant;
    return {
      version: 1,
      calendarId,
      accountId: grant.accountId,
      accountEmail: grant.accountEmail ?? null,
      calendarLabel:
        (typeof calendar.summaryOverride === "string" ? calendar.summaryOverride.trim() : "") ||
        (typeof calendar.summary === "string" ? calendar.summary.trim() : "") ||
        calendarId,
      read: true,
      write:
        grant.capabilities.includes("google.calendar.write") &&
        ["writer", "owner"].includes(String(calendar.accessRole)),
      idempotentCreate: true,
      conditionalWrites: true,
      providerExactlyOnce: false,
    };
  }
  private async identity(key: string) {
    if (!atom(key, 2048)) throw reject("A stable Calendar operation key is required.");
    const hash = await digest(key);
    return { hash, id: "e1" + hash };
  }
  private async raw(scope: Session, calendarId: string, id: string): Promise<Json | null> {
    if (!atom(id, 1024)) throw reject("Select an exact event.");
    const result = await this.call(scope, `${this.calendar(calendarId)}/${encodeURIComponent(id)}`);
    if (result.status === 404 || result.status === 410) {
      await this.access(scope, calendarId);
      return null;
    }
    if (result.status !== 200 || !result.data) throw providerFailure(result.status);
    if (result.data.id !== id)
      throw new CalendarSyncError(
        502,
        "CALENDAR_SYNC_IDENTITY",
        "unknown",
        "Google answered for a different event.",
      );
    if (result.data.status === "cancelled") return null;
    return result.data;
  }
  async get(
    owner: CalendarSyncOwner,
    calendarId: string,
    reference: { eventId?: string; idempotencyKey?: string },
  ) {
    if (!!reference.eventId === !!reference.idempotencyKey)
      throw reject("Select one exact event or operation key.");
    this.calendar(calendarId);
    if (reference.eventId && !atom(reference.eventId, 1024)) throw reject("Select an exact event.");
    const key = reference.idempotencyKey ? await this.identity(reference.idempotencyKey) : null,
      scope = await this.session(owner, "read"),
      raw = await this.raw(scope, calendarId, key?.id ?? reference.eventId!);
    if (!raw) return null;
    if (
      key &&
      (!record(raw.extendedProperties) ||
        !record(raw.extendedProperties.private) ||
        raw.extendedProperties.private.alphaSyncKey !== key.hash)
    )
      throw new CalendarSyncError(
        409,
        "CALENDAR_SYNC_KEY_MISMATCH",
        "not_accepted",
        "The event is not bound to this Calendar operation.",
      );
    return snapshot(raw);
  }
  async create(
    owner: CalendarSyncOwner,
    calendarId: string,
    idempotencyKey: string,
    value: unknown,
  ) {
    const event = eventInput(value),
      key = await this.identity(idempotencyKey),
      body = googleBody(event),
      fingerprint = await digest(JSON.stringify(body));
    this.calendar(calendarId);
    const scope = await this.session(owner, "write");
    const verify = async (raw: Json) => {
      const properties =
        record(raw.extendedProperties) && record(raw.extendedProperties.private)
          ? raw.extendedProperties.private
          : null;
      if (
        raw.id !== key.id ||
        properties?.alphaSyncKey !== key.hash ||
        properties.alphaSyncContent !== fingerprint
      )
        throw new CalendarSyncError(
          409,
          "CALENDAR_SYNC_CREATE_CHANGED",
          "precondition_failed",
          "This operation key is already bound to different event content.",
        );
      // The event exists and is bound to this key and content, so the create was applied.
      // Later divergence is an uncertain receipt, never "nothing was applied".
      const saved = snapshot(raw);
      if (saved.visibility !== "private" || !saved.remindersDisabled)
        throw new CalendarSyncError(
          409,
          "CALENDAR_SYNC_CREATE_CHANGED",
          "unknown",
          "This event was created, but its privacy or reminders changed afterward. Review its current settings.",
        );
      if (
        (await digest(JSON.stringify(googleBody(requestedView(raw, saved.event, event))))) !==
        fingerprint
      )
        throw new CalendarSyncError(
          409,
          "CALENDAR_SYNC_CREATE_CHANGED",
          "unknown",
          "This event was created, but it changed after its original create. Review both versions.",
        );
      return saved;
    };
    const prior = await this.raw(scope, calendarId, key.id);
    if (prior) return verify(prior);
    const result = await this.call(scope, this.calendar(calendarId) + "?sendUpdates=none", "POST", {
      id: key.id,
      ...body,
      visibility: "private",
      reminders: { useDefault: false },
      extendedProperties: { private: { alphaSyncKey: key.hash, alphaSyncContent: fingerprint } },
    });
    if (result.status === 409) {
      const existing = await this.raw(scope, calendarId, key.id);
      if (existing) return verify(existing);
      throw new CalendarSyncError(
        502,
        "CALENDAR_SYNC_OUTCOME_UNKNOWN",
        "unknown",
        "Google reported an existing create but its event could not be verified.",
      );
    }
    if (![200, 201].includes(result.status) || !result.data) throw providerFailure(result.status);
    return verify(result.data);
  }
  async update(
    owner: CalendarSyncOwner,
    calendarId: string,
    eventId: string,
    expectedEtag: string,
    value: unknown,
  ) {
    const event = eventInput(value);
    etag(expectedEtag);
    if (!atom(eventId, 1024)) throw reject("Select an exact event.");
    this.calendar(calendarId);
    const scope = await this.session(owner, "write");
    const previous = await this.raw(scope, calendarId, eventId);
    if (!previous || previous.etag !== expectedEtag)
      throw new CalendarSyncError(
        412,
        "CALENDAR_SYNC_PRECONDITION",
        "precondition_failed",
        "The Google event changed. Refresh before editing it.",
      );
    const before = snapshot(previous),
      body = replacement(previous, before.event, event);
    if (JSON.stringify(body) === JSON.stringify(previous)) return before;
    const result = await this.call(
      scope,
      `${this.calendar(calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=none&conferenceDataVersion=1&supportsAttachments=true&eventLabelVersion=${typeof previous.eventLabelId === "string" ? 1 : 0}`,
      "PUT",
      body,
      expectedEtag,
    );
    if (result.status !== 200 || !result.data) throw providerFailure(result.status);
    const saved = snapshot(result.data);
    if (saved.eventId !== eventId)
      throw new CalendarSyncError(
        502,
        "CALENDAR_SYNC_IDENTITY",
        "unknown",
        "Google answered for a different event.",
      );
    return saved;
  }
  async delete(
    owner: CalendarSyncOwner,
    calendarId: string,
    eventId: string,
    expectedEtag: string,
  ) {
    etag(expectedEtag);
    if (!atom(eventId, 1024)) throw reject("Select an exact event.");
    this.calendar(calendarId);
    const scope = await this.session(owner, "write");
    const result = await this.call(
      scope,
      `${this.calendar(calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=none`,
      "DELETE",
      undefined,
      expectedEtag,
    );
    if ([404, 410].includes(result.status)) {
      await this.access(scope, calendarId, true);
      return { deleted: true as const };
    }
    if (result.status !== 204) throw providerFailure(result.status);
    return { deleted: true as const };
  }
}
