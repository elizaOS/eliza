/**
 * CalendarService CRUD against a real PGlite-backed database.
 *
 * Self-contained: spins up an in-process PGlite instance with the calendar
 * tables, drives `CalendarService` through the Apple-calendar provider path
 * (native bridge mocked), and asserts persistence, feed aggregation,
 * next-event context, and that the injected `CalendarHostGate` receives the
 * reminder-plan side effects calendar events are expected to schedule.
 *
 * No Google grant and no full runtime are needed — the gate stubs the connector
 * layer, exactly as LifeOps injects its real implementation in production.
 */

import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import type { LifeOpsReminderPlan } from "@elizaos/shared";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { __testing, APPLE_CALENDAR_GRANT_ID } from "../src/apple-calendar.js";
import {
  type CalendarHostGate,
  CalendarService,
  ensureCalendarFeedPreferenceTable,
} from "../src/service/index.js";

const INTERNAL_URL = new URL("http://internal.local/api/calendar");

const APPLE_EVENT = {
  id: "apple-evt-1",
  externalId: "apple-evt-1",
  calendarId: "primary",
  calendarSummary: "Apple Calendar",
  title: "Dentist",
  description: "Checkup",
  location: "123 Main St",
  status: "confirmed",
  startAt: "2026-05-12T17:00:00.000Z",
  endAt: "2026-05-12T18:00:00.000Z",
  isAllDay: false,
  timezone: "UTC",
  attendees: [],
};

function appleBridge() {
  return {
    platform: "darwin",
    checkPermissions: async () => ({
      calendar: "granted" as const,
      canRequest: false,
    }),
    listCalendars: async () => ({
      ok: true as const,
      calendars: [
        {
          calendarId: "primary",
          summary: "Apple Calendar",
          primary: true,
          accessRole: "writer",
          selected: true,
        },
      ],
    }),
    listEvents: async () => ({ ok: true as const, events: [APPLE_EVENT] }),
    createEvent: async () => ({ ok: true as const, event: APPLE_EVENT }),
    updateEvent: async () => ({
      ok: true as const,
      event: { ...APPLE_EVENT, title: "Dentist (rescheduled)" },
    }),
    deleteEvent: async () => ({ ok: true as const }),
  };
}

const reminderPlans: LifeOpsReminderPlan[] = [];

function fakeGate(): CalendarHostGate {
  return {
    getGoogleConnectorAccounts: async () => [],
    resolveGuestAvailabilityGrants: async () => {
      throw new Error("Guest availability is outside this test.");
    },
    requireGoogleCalendarGrant: async () => {
      throw new Error("no google grant in this test");
    },
    requireGoogleCalendarWriteGrant: async () => {
      throw new Error("no google grant in this test");
    },
    createReminderPlan: async (plan) => {
      reminderPlans.push(plan);
    },
    updateReminderPlan: async () => {},
    deleteReminderPlan: async () => {},
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => {},
  };
}

let pg: PGlite;
let calendar: CalendarService;
const reportError = vi.fn();

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
  next_sync_token TEXT,
  synced_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent_id, provider, side, calendar_id)
)`;

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await db.execute(sql.raw("CREATE SCHEMA IF NOT EXISTS app_calendar"));
  await db.execute(sql.raw(CREATE_EVENTS_TABLE));
  await db.execute(sql.raw(CREATE_SYNC_TABLE));
  await ensureCalendarFeedPreferenceTable(
    async (statement) =>
      (await pg.query<Record<string, unknown>>(statement)).rows,
  );

  const runtime = {
    agentId: "agent-cal-test",
    adapter: { db },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    getCache: async () => undefined,
    setCache: async () => undefined,
    getService: () => null,
    reportError,
  } as unknown as IAgentRuntime;

  calendar = new CalendarService(runtime);
  calendar.setGate(fakeGate());
  __testing.setNativeCalendarBridgeForTest(appleBridge() as never);
});

afterAll(async () => {
  __testing.setNativeCalendarBridgeForTest(undefined as never);
  await pg.close();
});

describe("CalendarService (real PGlite, Apple provider)", () => {
  it("creates an Apple event, persists it, and schedules reminder plans", async () => {
    reminderPlans.length = 0;
    const created = await calendar.createCalendarEvent(INTERNAL_URL, {
      grantId: APPLE_CALENDAR_GRANT_ID,
      calendarId: "primary",
      title: "Dentist",
      startAt: "2026-05-12T17:00:00.000Z",
      endAt: "2026-05-12T18:00:00.000Z",
      timeZone: "UTC",
    });
    expect(created.title).toBe("Dentist");
    expect(created.provider).toBe("apple_calendar");
    // The event should schedule at least one reminder plan via the gate.
    expect(reminderPlans.length).toBeGreaterThan(0);
  });

  it("fails closed before a receipt-unaware add-only write", async () => {
    const createEvent = vi.fn(async () => ({
      ok: true as const,
      receipt: {
        accessLevel: "write_only" as const,
        destination: "default_calendar" as const,
        eventId: null,
        readBackAvailable: false as const,
      },
    }));
    __testing.setNativeCalendarBridgeForTest({
      ...appleBridge(),
      checkPermissions: async () => ({
        calendar: "write_only" as const,
        canRequest: true,
      }),
      createEvent,
    } as never);
    try {
      await expect(
        calendar.createCalendarEvent(INTERNAL_URL, {
          grantId: APPLE_CALENDAR_GRANT_ID,
          calendarId: "primary",
          title: "Add-only dentist",
          startAt: "2026-05-13T17:00:00.000Z",
          endAt: "2026-05-13T18:00:00.000Z",
          timeZone: "UTC",
        }),
      ).rejects.toMatchObject({
        code: "APPLE_CALENDAR_WRITE_ONLY_RECEIPT_REQUIRED",
      });
      expect(createEvent).not.toHaveBeenCalled();
    } finally {
      __testing.setNativeCalendarBridgeForTest(appleBridge() as never);
    }
  });

  it("returns and preserves an add-only receipt without a fake event row", async () => {
    __testing.setNativeCalendarBridgeForTest({
      ...appleBridge(),
      checkPermissions: async () => ({
        calendar: "write_only" as const,
        canRequest: true,
      }),
      createEvent: async () => ({
        ok: true as const,
        receipt: {
          accessLevel: "write_only" as const,
          destination: "default_calendar" as const,
          eventId: null,
          readBackAvailable: false as const,
        },
      }),
    } as never);
    try {
      const result = await calendar.createCalendarEventMutation(INTERNAL_URL, {
        grantId: APPLE_CALENDAR_GRANT_ID,
        calendarId: "primary",
        title: "Add-only dentist",
        startAt: "2026-05-13T17:00:00.000Z",
        endAt: "2026-05-13T18:00:00.000Z",
        timeZone: "UTC",
        idempotencyKey: "calendar-service-add-only-1",
      });
      expect(result).toMatchObject({
        outcome: "accepted_without_readback",
        event: null,
        writeOnlyReceipt: {
          provider: "apple_calendar",
          providerEventId: null,
          readBackAvailable: false,
        },
      });
      expect(
        await calendar.getCalendarEventById(
          "apple-write-only:calendar-service-add-only-1",
        ),
      ).toBeNull();
    } finally {
      __testing.setNativeCalendarBridgeForTest(appleBridge() as never);
    }
  });

  it("lists the Apple calendar", async () => {
    const calendars = await calendar.listCalendars(INTERNAL_URL, {
      grantId: APPLE_CALENDAR_GRANT_ID,
    });
    expect(calendars.some((c) => c.provider === "apple_calendar")).toBe(true);
  });

  it("keeps an unsupported Apple source explicit without systemic escalation", async () => {
    reportError.mockClear();
    __testing.setNativeCalendarBridgeForTest(null);
    try {
      const feed = await calendar.getCalendarFeed(
        INTERNAL_URL,
        {
          grantId: APPLE_CALENDAR_GRANT_ID,
          timeMin: "2036-05-12T00:00:00.000Z",
          timeMax: "2036-05-13T00:00:00.000Z",
        },
        new Date("2036-05-12T12:00:00.000Z"),
      );
      expect(feed.state).toBe("unavailable");
      expect(feed.sources).toEqual([
        expect.objectContaining({
          status: "disconnected",
          error: expect.objectContaining({
            code: "CALENDAR_SOURCE_UNSUPPORTED",
            retryable: false,
          }),
        }),
      ]);
      expect(reportError).not.toHaveBeenCalled();
    } finally {
      __testing.setNativeCalendarBridgeForTest(appleBridge() as never);
    }
  });

  it("still reports unexpected Apple feed failures", async () => {
    reportError.mockClear();
    __testing.setNativeCalendarBridgeForTest({
      ...appleBridge(),
      listEvents: async () => {
        throw new Error("EventKit transport failed");
      },
    } as never);
    try {
      const feed = await calendar.getCalendarFeed(
        INTERNAL_URL,
        {
          grantId: APPLE_CALENDAR_GRANT_ID,
          timeMin: "2037-05-12T00:00:00.000Z",
          timeMax: "2037-05-13T00:00:00.000Z",
        },
        new Date("2037-05-12T12:00:00.000Z"),
      );
      expect(feed.state).toBe("unavailable");
      expect(reportError).toHaveBeenCalledWith(
        "calendar:feed-source",
        expect.any(Error),
        {
          source: expect.objectContaining({
            calendarId: "all",
            connectorAccountId: APPLE_CALENDAR_GRANT_ID,
            grantId: APPLE_CALENDAR_GRANT_ID,
            provider: "apple_calendar",
            side: "owner",
          }),
          timeMin: "2037-05-12T00:00:00.000Z",
          timeMax: "2037-05-13T00:00:00.000Z",
        },
      );
    } finally {
      __testing.setNativeCalendarBridgeForTest(appleBridge() as never);
    }
  });

  it("returns the event in the aggregated feed", async () => {
    const feed = await calendar.getCalendarFeed(
      INTERNAL_URL,
      {
        grantId: APPLE_CALENDAR_GRANT_ID,
        timeMin: "2026-05-12T00:00:00.000Z",
        timeMax: "2026-05-13T00:00:00.000Z",
      },
      new Date("2026-05-12T12:00:00.000Z"),
    );
    expect(feed.events.some((e) => e.title === "Dentist")).toBe(true);
  });

  it("computes next-event context from the feed", async () => {
    const ctx = await calendar.getNextCalendarEventContext(
      INTERNAL_URL,
      { grantId: APPLE_CALENDAR_GRANT_ID },
      new Date("2026-05-12T16:30:00.000Z"),
    );
    expect(ctx.event?.title).toBe("Dentist");
    expect(ctx.startsInMinutes).toBe(30);
  });

  it("updates the Apple event through the bridge", async () => {
    const updated = await calendar.updateCalendarEvent(INTERNAL_URL, {
      grantId: APPLE_CALENDAR_GRANT_ID,
      calendarId: "primary",
      eventId: "apple-evt-1",
      title: "Dentist (rescheduled)",
    });
    expect(updated.title).toBe("Dentist (rescheduled)");
  });

  it("deletes the Apple event through the bridge", async () => {
    await expect(
      calendar.deleteCalendarEvent(INTERNAL_URL, {
        grantId: APPLE_CALENDAR_GRANT_ID,
        calendarId: "primary",
        eventId: "apple-evt-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("requires confirmation and purges only Eliza's exact Apple projection", async () => {
    await calendar.createCalendarEvent(INTERNAL_URL, {
      grantId: APPLE_CALENDAR_GRANT_ID,
      calendarId: "primary",
      title: "Disposable local projection",
      startAt: "2026-05-14T17:00:00.000Z",
      endAt: "2026-05-14T18:00:00.000Z",
      timeZone: "UTC",
    });
    const deleteEvent = vi.fn(async () => ({ ok: true as const }));
    __testing.setNativeCalendarBridgeForTest({
      ...appleBridge(),
      deleteEvent,
    } as never);
    try {
      const request = {
        provider: "apple_calendar" as const,
        side: "owner" as const,
        grantId: APPLE_CALENDAR_GRANT_ID,
        connectorAccountId: APPLE_CALENDAR_GRANT_ID,
        confirmAction: false,
      };
      await expect(calendar.purgeImportedCalendarData(request)).rejects.toThrow(
        /explicit confirmation/i,
      );

      const receipt = await calendar.purgeImportedCalendarData(
        { ...request, confirmAction: true },
        new Date("2026-08-22T09:00:00.000Z"),
      );

      expect(receipt).toMatchObject({
        provider: "apple_calendar",
        grantId: APPLE_CALENDAR_GRANT_ID,
        connectorAccountId: APPLE_CALENDAR_GRANT_ID,
        deletedEventCount: 1,
        providerMutation: false,
        purgedAt: "2026-08-22T09:00:00.000Z",
      });
      expect(deleteEvent).not.toHaveBeenCalled();
    } finally {
      __testing.setNativeCalendarBridgeForTest(appleBridge() as never);
    }
  });
});
