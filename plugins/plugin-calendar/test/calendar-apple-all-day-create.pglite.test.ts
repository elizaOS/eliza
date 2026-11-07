/** Creates an all-day event on Apple Calendar through the real CalendarService
 * and PGlite SQL; the native EventKit bridge is a recording fixture. EventKit
 * reads an all-day date as the local day of the instant it receives. */
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { RuntimeMigrator } from "@elizaos/plugin-sql";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { __testing } from "../src/apple-calendar.ts";
import { CalendarService, calendarSchema } from "../src/service/index.ts";

const URL_ = new URL("http://internal.local/api/calendar");
const message: Memory = {
  id: "00000000-0000-4000-8000-000000000001",
  roomId: "00000000-0000-4000-8000-000000000002",
  entityId: "00000000-0000-4000-8000-000000000003",
  createdAt: Date.parse("2026-09-23T07:52:04.976Z"),
  content: { text: "" },
};
let pg: PGlite;
let runtime: IAgentRuntime;
let service: CalendarService;
const bridgeCreates: Array<Record<string, unknown>> = [];
beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await new RuntimeMigrator(db).migrate(
    "@elizaos/plugin-calendar",
    calendarSchema,
  );
  runtime = {
    agentId: "00000000-0000-4000-8000-000000000004",
    actions: [],
    adapter: { db },
    db,
    initPromise: Promise.resolve(),
    getCache: async () => undefined,
    setCache: async () => undefined,
    getRoom: async () => ({
      id: message.roomId,
      worldId: "00000000-0000-4000-8000-000000000005",
    }),
    getWorld: async () => ({
      id: "00000000-0000-4000-8000-000000000005",
      metadata: { ownership: { ownerId: message.entityId } },
    }),
    getEntityById: async (id: string) => ({ id, metadata: {} }),
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? message.entityId : undefined,
    getService: (name: string) =>
      name === CalendarService.serviceType ? service : null,
    reportError: vi.fn(),
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    useModel: () => {
      throw new Error("Unexpected model invocation");
    },
  } as unknown as IAgentRuntime;
  service = new CalendarService(runtime);
  service.setGate({
    getGoogleConnectorAccounts: async () => [],
    resolveGuestAvailabilityGrants: async () => {
      throw new Error("No external guest lookup");
    },
    requireGoogleCalendarGrant: async () => {
      throw new Error("No external Google read");
    },
    requireGoogleCalendarWriteGrant: async () => {
      throw new Error("No external Google write");
    },
    createReminderPlan: async () => {},
    updateReminderPlan: async () => {},
    deleteReminderPlan: async () => {},
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => {},
  });
  __testing.setNativeCalendarBridgeForTest({
    platform: "fixture",
    checkPermissions: async () => ({
      calendar: "granted",
      canRequest: false,
      fullAccessSupported: true,
    }),
    listCalendars: async () => ({ ok: true, calendars: [] }),
    listEvents: async () => ({ ok: true, events: [] }),
    createEvent: async (payload: Record<string, unknown>) => {
      bridgeCreates.push(payload);
      return {
        ok: true,
        receipt: {
          accessLevel: "write_only",
          destination: "default_calendar",
          eventId: null,
          readBackAvailable: false,
        },
      };
    },
    updateEvent: async () => {
      throw new Error("No fixture update expected");
    },
    deleteEvent: async () => {
      throw new Error("No fixture delete expected");
    },
  } as never);
}, 30_000);
beforeEach(async () => {
  await pg.query("DELETE FROM app_calendar.life_calendar_events");
  await pg.query("DELETE FROM app_calendar.life_calendar_sync_states");
  await pg.query("DELETE FROM app_calendar.life_calendar_feed_preferences");
});
afterAll(async () => {
  __testing.setNativeCalendarBridgeForTest(undefined as never);
  await pg.close();
});

it.each([
  [
    "America/Los_Angeles",
    "2026-10-20T07:00:00.000Z",
    "2026-10-21T06:59:59.000Z",
  ],
  ["Europe/Berlin", "2026-10-19T22:00:00.000Z", "2026-10-20T21:59:59.000Z"],
])(
  "sends EventKit the local day of an all-day event in %s",
  async (timeZone, startAt, endAt) => {
    bridgeCreates.length = 0;
    const result = await service.createCalendarEventMutation(URL_, {
      grantId: "apple-calendar",
      title: "Offsite",
      timeZone,
      allDay: { startDate: "2026-10-20", endDateExclusive: "2026-10-21" },
    });
    expect(result.outcome).toBe("accepted_without_readback");
    expect(bridgeCreates).toEqual([
      expect.objectContaining({ startAt, endAt, timeZone, isAllDay: true }),
    ]);
  },
);
