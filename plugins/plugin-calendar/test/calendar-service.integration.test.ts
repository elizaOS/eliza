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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __testing, APPLE_CALENDAR_GRANT_ID } from "../src/apple-calendar.js";
import {
  type CalendarHostGate,
  CalendarService,
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

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await db.execute(sql.raw("CREATE SCHEMA IF NOT EXISTS app_calendar"));
  await db.execute(sql.raw(CREATE_EVENTS_TABLE));
  await db.execute(sql.raw(CREATE_SYNC_TABLE));

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

  it("lists the Apple calendar", async () => {
    const calendars = await calendar.listCalendars(INTERNAL_URL, {
      grantId: APPLE_CALENDAR_GRANT_ID,
    });
    expect(calendars.some((c) => c.provider === "apple_calendar")).toBe(true);
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
});
