/**
 * Exercises the built-in Eliza calendar through CalendarService against the
 * production PGlite schema. External providers stay disconnected so default
 * discovery, exact-once creation, feed truth, and versioned writes are proven
 * without a connector or a second event store.
 */

import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { RuntimeMigrator } from "@elizaos/plugin-sql/runtime-migrator";
import type { LifeOpsReminderPlan } from "@elizaos/shared";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __testing } from "../src/apple-calendar.js";
import {
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_ID,
} from "../src/internal/eliza-calendar.js";
import {
  type CalendarHostGate,
  CalendarService,
  calendarSchema,
} from "../src/service/index.js";

const AGENT_ID = "eliza-calendar-pglite-agent";
const INTERNAL_URL = new URL("http://internal.local/api/calendar");
const WINDOW = {
  timeMin: "2026-08-01T00:00:00.000Z",
  timeMax: "2026-09-01T00:00:00.000Z",
};

let pg: PGlite;
let service: CalendarService;
const reminderPlans: LifeOpsReminderPlan[] = [];

function gate(): CalendarHostGate {
  return {
    getGoogleConnectorAccounts: async () => [],
    resolveGuestAvailabilityGrants: async () => {
      throw new Error("Guest availability is outside this test.");
    },
    requireGoogleCalendarGrant: async () => {
      throw new Error("Google is outside this test.");
    },
    requireGoogleCalendarWriteGrant: async () => {
      throw new Error("Google is outside this test.");
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

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await new RuntimeMigrator(db).migrate(
    "@elizaos/plugin-calendar",
    calendarSchema,
  );
  const runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    db,
    initPromise: Promise.resolve(),
    getCache: async () => undefined,
    setCache: async () => undefined,
    getService: (serviceType: string) =>
      serviceType === CalendarService.serviceType ? service : null,
    reportError: async () => {},
  } as unknown as IAgentRuntime;
  service = new CalendarService(runtime);
  service.setGate(gate());
  __testing.setNativeCalendarBridgeForTest(null);
}, 30_000);

beforeEach(async () => {
  await pg.query("DELETE FROM app_calendar.life_calendar_events");
  await pg.query("DELETE FROM app_calendar.life_calendar_sync_states");
  await pg.query("DELETE FROM app_calendar.life_calendar_feed_preferences");
  reminderPlans.length = 0;
});

afterAll(async () => {
  __testing.setNativeCalendarBridgeForTest(undefined as never);
  await pg.close();
});

describe("built-in Eliza calendar (real PGlite)", { timeout: 30_000 }, () => {
  it("is the fresh writable default when no external account is connected", async () => {
    const calendars = await service.listCalendars(INTERNAL_URL);
    expect(calendars[0]).toMatchObject({
      provider: "eliza",
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      primary: true,
      accessRole: "owner",
    });

    const feed = await service.getCalendarFeed(INTERNAL_URL, WINDOW);
    expect(feed).toMatchObject({
      state: "complete",
      events: [],
      sources: [
        {
          key: {
            provider: "eliza",
            grantId: ELIZA_CALENDAR_GRANT_ID,
            calendarId: ELIZA_CALENDAR_ID,
          },
          status: "fresh",
        },
      ],
    });
  });

  it("creates once, replays idempotently, and returns the event through the canonical feed", async () => {
    const request = {
      title: "Demo with Shaw",
      startAt: "2026-08-06T23:00:00.000Z",
      endAt: "2026-08-07T00:00:00.000Z",
      timeZone: "America/Los_Angeles",
      idempotencyKey: "demo-with-shaw-2026-08-06",
    };
    const first = await service.createCalendarEventMutation(
      INTERNAL_URL,
      request,
    );
    expect(first.event).toMatchObject({
      provider: "eliza",
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      title: "Demo with Shaw",
      metadata: { version: 1, etag: '"eliza-1"' },
    });
    const reminderCount = reminderPlans.length;
    expect(reminderCount).toBeGreaterThan(0);

    const replay = await service.createCalendarEventMutation(
      INTERNAL_URL,
      request,
    );
    expect(replay.event?.id).toBe(first.event?.id);
    expect(reminderPlans).toHaveLength(reminderCount);
    const rows = await pg.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM app_calendar.life_calendar_events",
    );
    expect(rows.rows[0]?.count).toBe("1");

    const feed = await service.getCalendarFeed(INTERNAL_URL, WINDOW);
    expect(feed.state).toBe("complete");
    expect(feed.events.map((event) => event.title)).toEqual(["Demo with Shaw"]);
  });

  it("uses event ETags for atomic update and delete", async () => {
    const created = await service.createCalendarEventMutation(INTERNAL_URL, {
      title: "Calendar rehearsal",
      startAt: "2026-08-09T18:00:00.000Z",
      endAt: "2026-08-09T19:00:00.000Z",
      timeZone: "America/Los_Angeles",
      idempotencyKey: "calendar-rehearsal",
    });
    const event = created.event;
    if (!event) throw new Error("Built-in calendar create returned no event.");

    const updated = await service.updateCalendarEvent(INTERNAL_URL, {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      eventId: event.externalId,
      title: "Calendar rehearsal moved",
      expectedProviderVersion: '"eliza-1"',
    });
    expect(updated).toMatchObject({
      title: "Calendar rehearsal moved",
      metadata: { version: 2, etag: '"eliza-2"' },
    });

    await expect(
      service.updateCalendarEvent(INTERNAL_URL, {
        grantId: ELIZA_CALENDAR_GRANT_ID,
        calendarId: ELIZA_CALENDAR_ID,
        eventId: event.externalId,
        title: "Stale update",
        expectedProviderVersion: '"eliza-1"',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_PRECONDITION_FAILED",
    });

    await expect(
      service.deleteCalendarEvent(INTERNAL_URL, {
        grantId: ELIZA_CALENDAR_GRANT_ID,
        calendarId: ELIZA_CALENDAR_ID,
        eventId: event.externalId,
        expectedProviderVersion: '"eliza-1"',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_PRECONDITION_FAILED",
    });

    await service.deleteCalendarEvent(INTERNAL_URL, {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      eventId: event.externalId,
      expectedProviderVersion: '"eliza-2"',
    });
    expect(await service.getCalendarEventById(event.id)).toBeNull();
  });

  it("rejects unsupported or invalid built-in mutations without changing the event", async () => {
    const created = await service.createCalendarEventMutation(INTERNAL_URL, {
      title: "Keep this event",
      startAt: "2026-08-09T18:00:00.000Z",
      endAt: "2026-08-09T19:00:00.000Z",
      timeZone: "America/Los_Angeles",
      idempotencyKey: "built-in-mutation-guards",
    });
    const event = created.event;
    if (!event) throw new Error("Built-in calendar create returned no event.");
    const base = {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      eventId: event.externalId,
      expectedProviderVersion: '"eliza-1"',
    };

    await expect(
      service.updateCalendarEvent(INTERNAL_URL, { ...base, title: "   " }),
    ).rejects.toMatchObject({
      status: 400,
      code: "CALENDAR_EVENT_TITLE_REQUIRED",
    });
    await expect(
      service.updateCalendarEvent(INTERNAL_URL, {
        ...base,
        recurrence: ["RRULE:FREQ=DAILY"],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "ELIZA_CALENDAR_RECURRENCE_UNSUPPORTED",
    });
    await expect(
      service.deleteCalendarEvent(INTERNAL_URL, {
        ...base,
        notifyAttendees: true,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "ELIZA_CALENDAR_ATTENDEE_NOTIFICATIONS_UNSUPPORTED",
    });

    await expect(service.getCalendarEventById(event.id)).resolves.toMatchObject(
      {
        title: "Keep this event",
        metadata: { version: 1, etag: '"eliza-1"' },
      },
    );
  });
});
