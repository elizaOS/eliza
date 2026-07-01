// Keyless contract test: replays a REAL-shaped recorded Google Calendar
// events.list response (test/__fixtures__/google-calendar.recorded.json — the
// `response.data.items[]` calendar_v3.Schema$Event wire objects with the real
// Google Calendar v3 field names: summary, start/end {dateTime,timeZone} or
// {date}, htmlLink, hangoutLink, conferenceData.entryPoints[].uri, attendees[],
// organizer, iCalUID, recurringEventId, created, updated) through the FULL
// normalize chain:
//
//   raw events.list wire
//     -> GoogleCalendarClient.listEvents  (genuine mapEvent in @elizaos/plugin-google)
//        -> GoogleCalendarEvent
//     -> lifeOpsCalendarEventFromGoogle    (this plugin's src/internal/google-delegates.ts)
//        -> LifeOpsCalendarEvent           (the DTO the CalendarSection feed renders)
//
// This validates the connector against the real provider shape with NO network:
// the GoogleApiClientFactory is faked at the constructor seam (the same seam
// plugin-google's own index.test.ts uses), so the recorded `events.list` body
// flows through the real mapper. The key raw->normalized transforms exercised:
// start.dateTime "...-04:00" -> ISO Z startAt; start.date -> all-day
// midnight-Z bounds + isAllDay; hangoutLink/conferenceData -> conferenceLink;
// summary -> title (with the (untitled) default for the cancelled/minimal row);
// attendees[].displayName -> attendee.displayName; iCalUID/updated -> metadata.
// google-calendar-connector.real.test.ts re-fetches the live API to catch drift.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type GoogleApiClientFactory,
  GoogleCalendarClient,
} from "@elizaos/plugin-google";
import type { LifeOpsConnectorGrant } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { lifeOpsCalendarEventFromGoogle } from "../src/internal/google-delegates.js";

const recorded = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "./__fixtures__/google-calendar.recorded.json",
    ),
    "utf8",
  ),
) as {
  calendarId: string;
  eventsList: { data: { items: unknown[] } };
};

const AGENT_ID = "agent-7";

const ownerGrant: LifeOpsConnectorGrant = {
  id: "connector-account:acct-123",
  agentId: AGENT_ID,
  provider: "google",
  connectorAccountId: "acct-123",
  side: "owner",
  identity: { email: "owner@example.com" },
  identityEmail: "owner@example.com",
  grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  capabilities: ["google.calendar.read"],
  tokenRef: null,
  mode: "local",
  executionTarget: "local",
  sourceOfTruth: "connector_account",
  preferredByAgent: true,
  cloudConnectionId: null,
  metadata: {},
  lastRefreshAt: "2026-06-16T00:00:00.000Z",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-16T00:00:00.000Z",
};

// Fake googleapis Calendar surface returning the recorded events.list body.
// This is the constructor seam GoogleCalendarClient consumes; faking it drives
// the genuine mapEvent normalizer over the raw wire shape with no network.
function makeFactory(): {
  factory: GoogleApiClientFactory;
  eventsList: ReturnType<typeof vi.fn>;
} {
  const eventsList = vi.fn(async () => recorded.eventsList);
  const fakeCalendar = { events: { list: eventsList } };
  const factory = {
    calendar: vi.fn(async () => fakeCalendar),
  } as unknown as GoogleApiClientFactory;
  return { factory, eventsList };
}

describe("Google Calendar connector — recorded real events.list contract", () => {
  it("normalizes the real events.list wire shape through the full LifeOps chain", async () => {
    const { factory, eventsList } = makeFactory();
    const client = new GoogleCalendarClient(factory);

    const googleEvents = await client.listEvents({
      accountId: "acct-123",
      calendarId: recorded.calendarId,
      timeMin: "2026-06-17T00:00:00.000Z",
      timeMax: "2026-07-31T00:00:00.000Z",
      limit: 50,
    });

    // listEvents passes singleEvents/orderBy through to the real events.list.
    expect(eventsList).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "owner@example.com",
        singleEvents: true,
        orderBy: "startTime",
      }),
    );

    // mapEvent emits one GoogleCalendarEvent per raw item (incl. cancelled).
    expect(googleEvents).toHaveLength(3);

    const events = googleEvents.map((event) =>
      lifeOpsCalendarEventFromGoogle({
        event,
        grant: ownerGrant,
        agentId: AGENT_ID,
        syncedAt: "2026-06-16T08:00:00.000Z",
      }),
    );

    // --- timed event (raw start.dateTime "...-04:00") ---
    const timed = events[0];
    if (!timed) throw new Error("missing timed event");
    expect(timed.id).toBe(
      "agent-7:google:owner:calendar:owner@example.com:evt_abc123",
    );
    expect(timed.externalId).toBe("evt_abc123");
    expect(timed.provider).toBe("google");
    expect(timed.side).toBe("owner");
    expect(timed.calendarId).toBe("owner@example.com");
    // summary -> title; description/location pass through.
    expect(timed.title).toBe("Design sync");
    expect(timed.description).toBe("Weekly design review");
    expect(timed.location).toBe("Room 4B");
    expect(timed.status).toBe("confirmed");
    // start.dateTime "2026-06-17T11:00:00-04:00" -> ISO Z startAt.
    expect(timed.startAt).toBe("2026-06-17T15:00:00.000Z");
    expect(timed.endAt).toBe("2026-06-17T16:00:00.000Z");
    expect(timed.isAllDay).toBe(false);
    // start.timeZone -> timezone.
    expect(timed.timezone).toBe("America/New_York");
    expect(timed.htmlLink).toBe(
      "https://www.google.com/calendar/event?eid=evt_abc123",
    );
    // hangoutLink (preferred) / conferenceData.entryPoints[0].uri -> conferenceLink.
    expect(timed.conferenceLink).toBe("https://meet.google.com/abc-defg-hij");
    // organizer.{email,displayName,self} -> organizer (mapEvent renames to name).
    expect(timed.organizer).toEqual({
      email: "owner@example.com",
      name: "Owner Person",
      self: true,
    });
    // attendees[].displayName -> attendee.displayName; the Google summary
    // projection drops responseStatus/self/organizer/optional, so they default.
    expect(timed.attendees).toEqual([
      {
        email: "owner@example.com",
        displayName: "Owner Person",
        responseStatus: null,
        self: false,
        organizer: false,
        optional: false,
      },
      {
        email: "guest@elsewhere.com",
        displayName: "Guest",
        responseStatus: null,
        self: false,
        organizer: false,
        optional: false,
      },
    ]);
    // iCalUID/updated travel into metadata under googlePlugin.
    expect(timed.metadata.googlePlugin).toBe(true);
    expect(timed.metadata.iCalUID).toBe("evt_abc123@google.com");
    expect(timed.metadata.updatedAt).toBe("2026-06-15T12:00:00.000Z");
    expect(timed.syncedAt).toBe("2026-06-16T08:00:00.000Z");
    expect(timed.connectorAccountId).toBe("acct-123");
    expect(timed.grantId).toBe("connector-account:acct-123");
    expect(timed.accountEmail).toBe("owner@example.com");

    // --- all-day event (raw start.date "2026-07-04") ---
    const allDay = events[1];
    if (!allDay) throw new Error("missing all-day event");
    expect(allDay.title).toBe("Company holiday");
    expect(allDay.isAllDay).toBe(true);
    // date-only -> midnight-Z bounds (end is the exclusive next day).
    expect(allDay.startAt).toBe("2026-07-04T00:00:00.000Z");
    expect(allDay.endAt).toBe("2026-07-05T00:00:00.000Z");
    // No conference / no attendees on this event.
    expect(allDay.conferenceLink).toBeNull();
    expect(allDay.attendees).toEqual([]);

    // --- minimal cancelled event (only id + status on the wire) ---
    const minimal = events[2];
    if (!minimal) throw new Error("missing minimal event");
    expect(minimal.externalId).toBe("evt_min");
    expect(minimal.status).toBe("cancelled");
    // (untitled)/""/false/null defaults; calendarId falls back to "primary".
    expect(minimal.title).toBe("(untitled)");
    expect(minimal.description).toBe("");
    expect(minimal.location).toBe("");
    expect(minimal.isAllDay).toBe(false);
    expect(minimal.timezone).toBeNull();
    expect(minimal.htmlLink).toBeNull();
    expect(minimal.conferenceLink).toBeNull();
    expect(minimal.organizer).toBeNull();
    expect(minimal.attendees).toEqual([]);
    // mapEvent stamps the listEvents calendarId on every item, so even the
    // sparse cancelled row carries the queried calendar id (not a "primary"
    // fallback — that only applies when the wire item has no calendarId).
    expect(minimal.calendarId).toBe("owner@example.com");
    expect(minimal.id).toBe(
      "agent-7:google:owner:calendar:owner@example.com:evt_min",
    );
    // no start/end on the wire -> startAt falls back to syncedAt, endAt to startAt.
    expect(minimal.startAt).toBe("2026-06-16T08:00:00.000Z");
    expect(minimal.endAt).toBe("2026-06-16T08:00:00.000Z");

    // Every normalized event carries the required contract fields.
    for (const event of events) {
      expect(event.agentId).toBe(AGENT_ID);
      expect(event.provider).toBe("google");
      expect(typeof event.externalId).toBe("string");
      expect(event.externalId.length).toBeGreaterThan(0);
      expect(Number.isFinite(Date.parse(event.startAt))).toBe(true);
      expect(Number.isFinite(Date.parse(event.endAt))).toBe(true);
      expect(typeof event.isAllDay).toBe("boolean");
      expect(Array.isArray(event.attendees)).toBe(true);
    }
  });
});
