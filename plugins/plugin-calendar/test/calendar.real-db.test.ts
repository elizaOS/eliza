/**
 * Real-DB integration tests for the calendar back-end.
 *
 * Unlike `calendar-service.integration.test.ts` (which hand-rolls a fake
 * runtime over a bare PGlite instance and CREATEs the tables by hand), this
 * suite boots a REAL PGLite-backed AgentRuntime via {@link createRealTestRuntime}
 * and materializes the calendar tables the way the runtime does in production:
 * the calendar store reads/writes the carved `app_calendar.life_calendar_*`
 * tables. We register a schema-only test plugin that exposes `calendarSchema`
 * (rather than the full calendar plugin) to keep the test runtime minimal,
 * letting the SQL plugin's migration runner create the tables on
 * `runtime.initialize()`.
 *
 * Two layers are round-tripped against the live DB:
 *   1. `CalendarRepository` — upsert an event/sync-state, read it back.
 *   2. `CalendarService` (Apple provider) — create/update/delete an event with
 *      the native EventKit bridge mocked and a no-op connector gate, then read
 *      it back through `getCalendarFeed` / `getNextCalendarEventContext`. The
 *      external Apple feed is the only mock; the DB store is fully real.
 *
 * Hermetic: no network, no credentials, no Google grant, no native EventKit.
 */

import type { AgentRuntime, Plugin } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsReminderPlan,
} from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/test/helpers/real-runtime.ts";
import { __testing, APPLE_CALENDAR_GRANT_ID } from "../src/apple-calendar.ts";
import {
  type CalendarHostGate,
  CalendarRepository,
  CalendarService,
  calendarSchema,
  createLifeOpsCalendarSyncState,
} from "../src/service/index.ts";

const INTERNAL_URL = new URL("http://internal.local/api/calendar");

/**
 * Schema-only test plugin. In production the calendar plugin registers
 * `calendarSchema` (the carved `app_calendar` tables) itself; here we register
 * just the schema (not the full plugin's services/actions) so
 * `runtime.initialize()` runs the SQL plugin migration that creates
 * `life_calendar_events` + `life_calendar_sync_states` with minimal surface.
 */
const calendarSchemaPlugin: Plugin = {
  name: "calendar-real-db-schema",
  description: "Test-only calendar table bootstrap.",
  schema: calendarSchema,
};

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

/** Mocked native EventKit bridge — the only external dependency. */
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

/** No-op connector gate (production LifeOps injects the real one). */
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

describe("CalendarRepository + CalendarService — real PGLite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let repository: CalendarRepository;
  let calendar: CalendarService;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "calendar-real-db-tests",
      plugins: [calendarSchemaPlugin],
    });
    runtime = testResult.runtime;
    repository = new CalendarRepository(runtime);
    calendar = new CalendarService(runtime);
    calendar.setGate(fakeGate());
    __testing.setNativeCalendarBridgeForTest(appleBridge() as never);
  }, 180_000);

  afterAll(async () => {
    __testing.setNativeCalendarBridgeForTest(undefined as never);
    await testResult?.cleanup();
  });

  it("upserts an event via the repository and reads it back from the live DB", async () => {
    const event: LifeOpsCalendarEvent = {
      id: `${runtime.agentId}:google:owner:calendar:primary:repo-evt-1`,
      externalId: "repo-evt-1",
      agentId: runtime.agentId,
      provider: "google",
      side: "owner",
      calendarId: "primary",
      title: "Standup",
      description: "Daily standup",
      location: "Zoom",
      status: "confirmed",
      startAt: "2026-06-01T09:00:00.000Z",
      endAt: "2026-06-01T09:15:00.000Z",
      isAllDay: false,
      timezone: "UTC",
      htmlLink: null,
      conferenceLink: null,
      organizer: null,
      attendees: [],
      metadata: { source: "real-db-test" },
      syncedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      grantId: "grant-1",
    };
    await repository.upsertCalendarEvent(event, "owner");

    // Round-trip: the row is really in the DB, parsed back into a domain event.
    const rows = await repository.listCalendarEvents(
      runtime.agentId,
      "google",
      "2026-06-01T00:00:00.000Z",
      "2026-06-02T00:00:00.000Z",
      "owner",
    );
    const fetched = rows.find((e) => e.externalId === "repo-evt-1");
    expect(fetched).toBeTruthy();
    expect(fetched?.title).toBe("Standup");
    expect(fetched?.description).toBe("Daily standup");
    expect(fetched?.location).toBe("Zoom");
    expect(fetched?.metadata).toEqual({ source: "real-db-test" });

    // ON CONFLICT DO UPDATE: re-upsert with a new title updates the same row.
    await repository.upsertCalendarEvent(
      {
        ...event,
        title: "Standup (moved)",
        updatedAt: new Date().toISOString(),
      },
      "owner",
    );
    const reread = (
      await repository.listCalendarEvents(
        runtime.agentId,
        "google",
        "2026-06-01T00:00:00.000Z",
        "2026-06-02T00:00:00.000Z",
        "owner",
      )
    ).filter((e) => e.externalId === "repo-evt-1");
    expect(reread).toHaveLength(1);
    expect(reread[0]?.title).toBe("Standup (moved)");
  });

  it("upserts + reads a calendar sync-state row against the live DB", async () => {
    const state = createLifeOpsCalendarSyncState({
      agentId: runtime.agentId,
      provider: "google",
      side: "owner",
      calendarId: "primary",
      windowStartAt: "2026-06-01T00:00:00.000Z",
      windowEndAt: "2026-06-08T00:00:00.000Z",
      syncedAt: new Date().toISOString(),
    });
    await repository.upsertCalendarSyncState(state);

    const fetched = await repository.getCalendarSyncState(
      runtime.agentId,
      "google",
      "primary",
      "owner",
    );
    expect(fetched).not.toBeNull();
    expect(fetched?.windowStartAt).toBe("2026-06-01T00:00:00.000Z");
    expect(fetched?.windowEndAt).toBe("2026-06-08T00:00:00.000Z");
  });

  it("CalendarService creates an Apple event that persists into the live DB", async () => {
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
    // The service scheduled at least one reminder plan via the injected gate.
    expect(reminderPlans.length).toBeGreaterThan(0);

    // Round-trip: the event the service wrote is really in the DB, not the mock.
    const persisted = await repository.listCalendarEvents(
      runtime.agentId,
      "apple_calendar",
      "2026-05-12T00:00:00.000Z",
      "2026-05-13T00:00:00.000Z",
      "owner",
    );
    const dentist = persisted.find((e) => e.externalId === "apple-evt-1");
    expect(dentist).toBeTruthy();
    expect(dentist?.title).toBe("Dentist");
    expect(dentist?.location).toBe("123 Main St");
  });

  it("getCalendarFeed reads the persisted event back, and next-event context resolves it", async () => {
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

    const ctx = await calendar.getNextCalendarEventContext(
      INTERNAL_URL,
      { grantId: APPLE_CALENDAR_GRANT_ID },
      new Date("2026-05-12T16:30:00.000Z"),
    );
    expect(ctx.event?.title).toBe("Dentist");
    expect(ctx.startsInMinutes).toBe(30);
  });

  it("deletes the Apple event and the row is gone from the live DB", async () => {
    await calendar.deleteCalendarEvent(INTERNAL_URL, {
      grantId: APPLE_CALENDAR_GRANT_ID,
      calendarId: "primary",
      eventId: "apple-evt-1",
    });
    const remaining = await repository.listCalendarEvents(
      runtime.agentId,
      "apple_calendar",
      "2026-05-12T00:00:00.000Z",
      "2026-05-13T00:00:00.000Z",
      "owner",
    );
    expect(remaining.some((e) => e.externalId === "apple-evt-1")).toBe(false);
  });
});
