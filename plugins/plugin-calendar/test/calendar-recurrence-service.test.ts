/**
 * CalendarService recurring-event semantics against a real PGlite-backed
 * cache and the plugin-google service seam (spied, provider-shaped).
 *
 * Covers the RRULE lifecycle the flattened feed cannot express on its own:
 *
 *   - create: recurrence lines validated fail-closed, passed to the provider,
 *     and visible on readback (event.recurrence)
 *   - create (Apple / Apple fallback): recurring requests are rejected, never
 *     silently created as one-off events
 *   - update scope=series through an occurrence id: resolves the cached
 *     `recurringEventId` and patches the series master
 *   - update scope=instance + recurrence lines: 400 (rules are series-level)
 *   - delete scope=series: ONE provider delete against the master id and a
 *     purge of every cached occurrence of that series — while another
 *     account's rows survive (grantId isolation)
 *   - delete without scope: the addressed occurrence only
 */

import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsConnectorGrant,
} from "@elizaos/shared";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { APPLE_CALENDAR_GRANT_ID } from "../src/apple-calendar.js";
import { CalendarServiceError } from "../src/internal/errors.js";
import { CalendarRepository } from "../src/service/CalendarRepository.js";
import {
  type CalendarHostGate,
  CalendarService,
} from "../src/service/index.js";

const INTERNAL_URL = new URL("http://internal.local/api/calendar");
const AGENT_ID = "agent-rrule-test";

const GRANT_A: LifeOpsConnectorGrant = {
  id: "connector-account:acct-a",
  agentId: AGENT_ID,
  provider: "google",
  connectorAccountId: "acct-a",
  side: "owner",
  identity: { email: "owner@example.com" },
  identityEmail: "owner@example.com",
  grantedScopes: ["https://www.googleapis.com/auth/calendar"],
  capabilities: ["google.calendar.read", "google.calendar.write"],
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

function cachedOccurrence(args: {
  externalId: string;
  grantId: string;
  recurringEventId?: string;
  startAt?: string;
}): LifeOpsCalendarEvent {
  const startAt = args.startAt ?? "2026-07-08T13:00:00.000Z";
  return {
    id: `${AGENT_ID}:google:owner:calendar:primary:${args.externalId}`,
    externalId: args.externalId,
    agentId: AGENT_ID,
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: "Team Standup",
    description: "",
    location: "",
    status: "confirmed",
    startAt,
    endAt: "2026-07-08T13:30:00.000Z",
    isAllDay: false,
    timezone: "America/New_York",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: args.recurringEventId
      ? { recurringEventId: args.recurringEventId }
      : {},
    syncedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    grantId: args.grantId,
    connectorAccountId: args.grantId.replace("connector-account:", ""),
  };
}

function googleWireEvent(args: {
  id: string;
  recurrence?: string[];
  recurringEventId?: string;
}) {
  return {
    id: args.id,
    calendarId: "primary",
    title: "Team Standup",
    status: "confirmed",
    start: "2026-07-08T13:00:00.000Z",
    end: "2026-07-08T13:30:00.000Z",
    isAllDay: false,
    timeZone: "America/New_York",
    recurrence: args.recurrence ?? null,
    recurringEventId: args.recurringEventId ?? null,
    metadata: {
      iCalUID: `${args.id}@google.com`,
      recurringEventId: args.recurringEventId ?? null,
      ...(args.recurrence ? { recurrence: args.recurrence } : {}),
    },
  };
}

function fakeGoogleService() {
  return {
    createEvent: vi.fn(async (input: { recurrence?: string[] }) =>
      googleWireEvent({ id: "created-master", recurrence: input.recurrence }),
    ),
    updateEvent: vi.fn(async (input: { eventId: string }) =>
      googleWireEvent({
        id: input.eventId,
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
      }),
    ),
    deleteEvent: vi.fn(async () => undefined),
    getEvent: vi.fn(async (input: { eventId: string }) =>
      googleWireEvent({
        id: input.eventId,
        recurringEventId: "uncached-master",
      }),
    ),
  };
}

type FakeGoogle = ReturnType<typeof fakeGoogleService>;

function fakeGate(): CalendarHostGate {
  return {
    getGoogleConnectorAccounts: async () => [],
    requireGoogleCalendarGrant: async () => GRANT_A,
    requireGoogleCalendarWriteGrant: async () => GRANT_A,
    createReminderPlan: async () => {},
    updateReminderPlan: async () => {},
    deleteReminderPlan: async () => {},
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => {},
  };
}

const CREATE_EVENTS_TABLE = `CREATE TABLE app_calendar.life_calendar_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  side TEXT NOT NULL DEFAULT 'owner',
  calendar_id TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  connector_account_id TEXT,
  purge_resync_required BOOLEAN NOT NULL DEFAULT false,
  purge_resync_reason TEXT,
  grant_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  is_all_day BOOLEAN NOT NULL DEFAULT false,
  timezone TEXT,
  html_link TEXT,
  conference_link TEXT,
  organizer_json TEXT,
  attendees_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent_id, provider, side, calendar_id, external_event_id)
)`;

const CREATE_SYNC_TABLE = `CREATE TABLE app_calendar.life_calendar_sync_states (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  side TEXT NOT NULL DEFAULT 'owner',
  calendar_id TEXT NOT NULL,
  connector_account_id TEXT,
  grant_id TEXT,
  purge_resync_required BOOLEAN NOT NULL DEFAULT false,
  purge_resync_reason TEXT,
  window_start_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent_id, provider, side, calendar_id)
)`;

let pg: PGlite;
let calendar: CalendarService;
let repo: CalendarRepository;
let google: FakeGoogle;

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await db.execute(sql.raw("CREATE SCHEMA IF NOT EXISTS app_calendar"));
  await db.execute(sql.raw(CREATE_EVENTS_TABLE));
  await db.execute(sql.raw(CREATE_SYNC_TABLE));

  google = fakeGoogleService();
  const runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    getCache: async () => undefined,
    setCache: async () => undefined,
    getService: (name: string) => (name === "google" ? google : null),
  } as unknown as IAgentRuntime;

  calendar = new CalendarService(runtime);
  calendar.setGate(fakeGate());
  repo = new CalendarRepository(runtime);
});

afterAll(async () => {
  await pg.close();
});

async function resetCache(): Promise<void> {
  await repo.deleteCalendarEventsForProvider(AGENT_ID, "google");
  // Two occurrences of one series (account A), one foreign-account occurrence,
  // and one one-off event.
  await repo.upsertCalendarEvent(
    cachedOccurrence({
      externalId: "standup_20260708T130000Z",
      grantId: GRANT_A.id,
      recurringEventId: "standup-master",
    }),
  );
  await repo.upsertCalendarEvent(
    cachedOccurrence({
      externalId: "standup_20260715T130000Z",
      grantId: GRANT_A.id,
      recurringEventId: "standup-master",
      startAt: "2026-07-15T13:00:00.000Z",
    }),
  );
  await repo.upsertCalendarEvent(
    cachedOccurrence({
      externalId: "other-account-standup_1",
      grantId: "connector-account:acct-b",
      recurringEventId: "other-account-master",
    }),
  );
  await repo.upsertCalendarEvent(
    cachedOccurrence({ externalId: "one-off-evt", grantId: GRANT_A.id }),
  );
}

beforeEach(async () => {
  google.createEvent.mockClear();
  google.updateEvent.mockClear();
  google.deleteEvent.mockClear();
  google.getEvent.mockClear();
  await resetCache();
});

describe("createCalendarEvent — recurrence", () => {
  it("normalizes recurrence to the provider and surfaces it on readback", async () => {
    const created = await calendar.createCalendarEvent(INTERNAL_URL, {
      title: "Morning Run",
      startAt: "2026-07-06T13:00:00.000Z",
      endAt: "2026-07-06T13:30:00.000Z",
      timeZone: "UTC",
      recurrence: ["rrule:freq=weekly;byday=mo"],
    });
    expect(google.createEvent).toHaveBeenCalledTimes(1);
    expect(google.createEvent.mock.calls[0]?.[0]).toMatchObject({
      accountId: "acct-a",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });
    // Readback carries the recurrence metadata through the full chain.
    expect(created.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
    expect(created.metadata.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
    // And the cached row round-trips it.
    const cached = (await repo.listCalendarEvents(AGENT_ID, "google")).find(
      (event) => event.externalId === "created-master",
    );
    expect(cached?.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
  });

  it("rejects invalid recurrence fail-closed — no provider call, no one-off event", async () => {
    await expect(
      calendar.createCalendarEvent(INTERNAL_URL, {
        title: "Morning Run",
        startAt: "2026-07-06T13:00:00.000Z",
        endAt: "2026-07-06T13:30:00.000Z",
        timeZone: "UTC",
        recurrence: ["every monday at 9"],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "CALENDAR_INVALID_RECURRENCE",
    });
    expect(google.createEvent).not.toHaveBeenCalled();
  });

  it("rejects recurring creates on the Apple Calendar path", async () => {
    await expect(
      calendar.createCalendarEvent(INTERNAL_URL, {
        grantId: APPLE_CALENDAR_GRANT_ID,
        title: "Morning Run",
        startAt: "2026-07-06T13:00:00.000Z",
        endAt: "2026-07-06T13:30:00.000Z",
        timeZone: "UTC",
        recurrence: ["RRULE:FREQ=DAILY"],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "CALENDAR_RECURRENCE_UNSUPPORTED_PROVIDER",
    });
    expect(google.createEvent).not.toHaveBeenCalled();
  });
});

describe("updateCalendarEvent — instance vs series", () => {
  it("series scope through an occurrence id patches the cached series master", async () => {
    const updated = await calendar.updateCalendarEvent(INTERNAL_URL, {
      eventId: "standup_20260708T130000Z",
      title: "Daily Sync",
      recurrenceScope: "series",
    });
    expect(google.updateEvent).toHaveBeenCalledTimes(1);
    expect(google.updateEvent.mock.calls[0]?.[0]).toMatchObject({
      eventId: "standup-master",
      title: "Daily Sync",
    });
    // No provider lookup needed: the cache knew the master id.
    expect(google.getEvent).not.toHaveBeenCalled();
    expect(updated.externalId).toBe("standup-master");
  });

  it("series scope for an uncached id resolves the master via the provider", async () => {
    await calendar.updateCalendarEvent(INTERNAL_URL, {
      eventId: "not-in-cache_20260722T130000Z",
      title: "Daily Sync",
      recurrenceScope: "series",
    });
    expect(google.getEvent).toHaveBeenCalledTimes(1);
    expect(google.updateEvent.mock.calls[0]?.[0]).toMatchObject({
      eventId: "uncached-master",
    });
  });

  it("instance scope patches exactly the addressed occurrence", async () => {
    await calendar.updateCalendarEvent(INTERNAL_URL, {
      eventId: "standup_20260708T130000Z",
      startAt: "2026-07-08T14:00:00.000Z",
      recurrenceScope: "instance",
    });
    expect(google.updateEvent).toHaveBeenCalledTimes(1);
    expect(google.updateEvent.mock.calls[0]?.[0]).toMatchObject({
      eventId: "standup_20260708T130000Z",
    });
    expect(google.getEvent).not.toHaveBeenCalled();
  });

  it("recurrence lines imply a series edit and reach the provider patch", async () => {
    await calendar.updateCalendarEvent(INTERNAL_URL, {
      eventId: "standup_20260708T130000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
    });
    expect(google.updateEvent.mock.calls[0]?.[0]).toMatchObject({
      eventId: "standup-master",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
    });
  });

  it("rejects recurrence lines with instance scope (rules are series-level)", async () => {
    await expect(
      calendar.updateCalendarEvent(INTERNAL_URL, {
        eventId: "standup_20260708T130000Z",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
        recurrenceScope: "instance",
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "CALENDAR_RECURRENCE_SCOPE_CONFLICT",
    });
    expect(google.updateEvent).not.toHaveBeenCalled();
  });

  it("rejects an invalid recurrenceScope fail-closed", async () => {
    await expect(
      calendar.updateCalendarEvent(INTERNAL_URL, {
        eventId: "standup_20260708T130000Z",
        title: "Daily Sync",
        recurrenceScope: "everything" as never,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "CALENDAR_INVALID_RECURRENCE_SCOPE",
    });
    expect(google.updateEvent).not.toHaveBeenCalled();
  });
});

describe("deleteCalendarEvent — instance vs series", () => {
  it("series scope deletes the master once and purges cached occurrences, preserving other accounts", async () => {
    await calendar.deleteCalendarEvent(INTERNAL_URL, {
      eventId: "standup_20260708T130000Z",
      recurrenceScope: "series",
    });
    // ONE provider call against the series master — no per-occurrence loop.
    expect(google.deleteEvent).toHaveBeenCalledTimes(1);
    expect(google.deleteEvent.mock.calls[0]?.[0]).toMatchObject({
      eventId: "standup-master",
    });
    const remaining = await repo.listCalendarEvents(AGENT_ID, "google");
    const remainingIds = remaining.map((event) => event.externalId).sort();
    // Both cached occurrences of the deleted series are gone; the foreign
    // account's series and the one-off event survive (grant isolation).
    expect(remainingIds).toEqual(["one-off-evt", "other-account-standup_1"]);
  });

  it("without scope deletes exactly the addressed occurrence", async () => {
    await calendar.deleteCalendarEvent(INTERNAL_URL, {
      eventId: "standup_20260708T130000Z",
    });
    expect(google.deleteEvent).toHaveBeenCalledTimes(1);
    expect(google.deleteEvent.mock.calls[0]?.[0]).toMatchObject({
      eventId: "standup_20260708T130000Z",
    });
    const remainingIds = (await repo.listCalendarEvents(AGENT_ID, "google"))
      .map((event) => event.externalId)
      .sort();
    expect(remainingIds).toEqual([
      "one-off-evt",
      "other-account-standup_1",
      "standup_20260715T130000Z",
    ]);
  });

  it("rejects an invalid recurrenceScope fail-closed", async () => {
    await expect(
      calendar.deleteCalendarEvent(INTERNAL_URL, {
        eventId: "standup_20260708T130000Z",
        recurrenceScope: "next-three" as never,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "CALENDAR_INVALID_RECURRENCE_SCOPE",
    });
    expect(google.deleteEvent).not.toHaveBeenCalled();
  });
});

describe("CalendarServiceError typing", () => {
  it("recurrence failures are CalendarServiceError instances", async () => {
    try {
      await calendar.createCalendarEvent(INTERNAL_URL, {
        title: "x",
        startAt: "2026-07-06T13:00:00.000Z",
        endAt: "2026-07-06T13:30:00.000Z",
        timeZone: "UTC",
        recurrence: ["nope"],
      });
      expect.unreachable("expected create to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CalendarServiceError);
    }
  });
});
