/**
 * Exercises calendar persistence, Apple mutation receipts and feed behavior with
 * a real PGlite-backed AgentRuntime and the production calendar schema.
 * The external EventKit bridge and host reminder hooks are controlled.
 */

import type { AgentRuntime, Plugin } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsReminderPlan,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app-core/test/helpers/real-runtime.ts";
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
const reportError = vi.fn();

/** No-op connector gate (production LifeOps injects the real one). */
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

describe("CalendarRepository + CalendarService — real PGLite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let repository: CalendarRepository;
  let calendar: CalendarService;

  beforeEach(async () => {
    testResult = await createRealTestRuntime({
      characterName: "calendar-real-db-tests",
      plugins: [calendarSchemaPlugin],
    });
    runtime = testResult.runtime;
    reminderPlans.length = 0;
    reportError.mockClear();
    vi.spyOn(runtime, "reportError").mockImplementation(reportError);
    repository = new CalendarRepository(runtime);
    calendar = new CalendarService(runtime);
    calendar.setGate(fakeGate());
    __testing.setNativeCalendarBridgeForTest(appleBridge() as never);
  }, 180_000);

  afterEach(async () => {
    __testing.setNativeCalendarBridgeForTest(undefined as never);
    await testResult?.cleanup();
    vi.restoreAllMocks();
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
      grantId: "connector-account:test",
      connectorAccountId: "test",
      calendarId: "primary",
      windowStartAt: "2026-06-01T00:00:00.000Z",
      windowEndAt: "2026-06-08T00:00:00.000Z",
      nextSyncToken: "sync-token-1",
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

  it("creates, reads, updates and deletes an Apple event with persisted state and reminder effects", async () => {
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

    expect(
      (
        await calendar.listCalendars(INTERNAL_URL, {
          grantId: APPLE_CALENDAR_GRANT_ID,
        })
      ).some((entry) => entry.provider === "apple_calendar"),
    ).toBe(true);
    const updated = await calendar.updateCalendarEvent(INTERNAL_URL, {
      grantId: APPLE_CALENDAR_GRANT_ID,
      calendarId: "primary",
      eventId: "apple-evt-1",
      title: "Dentist (rescheduled)",
    });
    expect(updated.title).toBe("Dentist (rescheduled)");
    expect((await calendar.getCalendarEventById(created.id))?.title).toBe(
      updated.title,
    );

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
