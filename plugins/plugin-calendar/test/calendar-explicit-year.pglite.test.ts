/** Exercises conversational date correction through the real Calendar action,
 * CalendarService and PGlite SQL. Runtime, model extraction and host gate are
 * deterministic doubles; external grant requests reject and no model is called.
 * Structured service inputs retain their separate contract. */
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { RuntimeMigrator } from "@elizaos/plugin-sql";
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
import { createCalendarActionRunner } from "../src/actions/calendar-handler.ts";
import { __testing } from "../src/apple-calendar.ts";
import {
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_ID,
} from "../src/internal/eliza-calendar.ts";
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
  __testing.setNativeCalendarBridgeForTest(null);
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

async function create(args: {
  text: string;
  intent?: string;
  start?: string;
  end?: string;
  zone?: string;
  plannerStart?: string;
  createdAt?: string;
}) {
  const zone = args.zone ?? "UTC";
  const action = createCalendarActionRunner({
    runTextModel: async () => null,
    runJsonModel: async () => ({
      rawResponse: JSON.stringify({
        startAt: args.start,
        endAt: args.end,
        timeZone: zone,
      }),
      parsed: { startAt: args.start, endAt: args.end, timeZone: zone },
    }),
    recentConversationTexts: async () => [],
  });
  const result = await action.handler(
    runtime,
    {
      ...message,
      ...(args.createdAt ? { createdAt: Date.parse(args.createdAt) } : {}),
      content: { text: args.text, metadata: { uiTimeZone: zone } },
    },
    undefined,
    {
      parameters: {
        subaction: "create_event",
        intent: args.intent ?? args.text,
        title: "Lunch",
        details: {
          grantId: ELIZA_CALENDAR_GRANT_ID,
          calendarId: ELIZA_CALENDAR_ID,
          timeZone: zone,
          start: args.plannerStart ?? args.start,
          end: args.end,
        },
      },
    },
  );
  return result;
}
async function rows() {
  return (
    await pg.query<{ start_at: string; end_at: string; timezone: string }>(
      "SELECT start_at, end_at, timezone FROM app_calendar.life_calendar_events",
    )
  ).rows;
}
async function expectSaved(start: string, end: string, zone = "UTC") {
  const stored = await rows();
  expect(stored).toHaveLength(1);
  expect(Date.parse(stored[0].start_at)).toBe(Date.parse(start));
  expect(Date.parse(stored[0].end_at)).toBe(Date.parse(end));
  expect(stored[0].timezone).toBe(zone);
}

describe("explicit Calendar year preservation", { timeout: 30_000 }, () => {
  it.each([
    { zone: "UTC", start: "2050-08-04T15:00:00Z", end: "2050-08-04T16:00:00Z" },
    {
      zone: "America/New_York",
      start: "2050-08-04T19:00:00Z",
      end: "2050-08-04T20:00:00Z",
    },
  ])(
    "keeps the comma-form year and civil clock in $zone through SQL",
    async ({ zone, start, end }) => {
      const result = await create({
        text: `Create Lunch on August 4, 2050 at 3 PM for one hour in ${zone}.`,
        start: "2050-08-04T15:00:00",
        end: "2050-08-04T16:00:00",
        zone,
      });
      expect(result).toMatchObject({ success: true });
      await expectSaved(start, end, zone);
    },
  );

  it("keeps extraction grounded in the stated year over conflicting native planner timing", async () => {
    const result = await create({
      text: "Create Lunch on August 4, 2050 at 3 PM UTC for one hour.",
      start: "2050-08-04T15:00:00Z",
      end: "2050-08-04T16:00:00Z",
      plannerStart: "2026-08-04T15:00:00Z",
    });
    expect(result).toMatchObject({ success: true });
    await expectSaved("2050-08-04T15:00:00Z", "2050-08-04T16:00:00Z");
  });

  it("narrows two same-month/day requests by their distinct explicit years", async () => {
    const result = await create({
      text: "Create Lunch on August 4, 2050 and another Lunch on August 4, 2051, both at 3 PM UTC for one hour.",
      intent:
        "Create the second Lunch on August 4, 2051 at 3 PM UTC for one hour.",
      start: "2051-08-04T15:00:00Z",
      end: "2051-08-04T16:00:00Z",
    });
    expect(result).toMatchObject({ success: true });
    await expectSaved("2051-08-04T15:00:00Z", "2051-08-04T16:00:00Z");
  });

  it("uses an intact intent date when the current message only confirms it", async () => {
    const result = await create({
      text: "Yes, create Lunch at that time.",
      intent: "Create Lunch on August 4, 2050 at 3 PM UTC for one hour.",
      start: "2050-08-04T15:00:00Z",
      end: "2050-08-04T16:00:00Z",
    });
    expect(result).toMatchObject({ success: true });
    await expectSaved("2050-08-04T15:00:00Z", "2050-08-04T16:00:00Z");
  });

  it("anchors a relative date to the request timestamp", async () => {
    const result = await create({
      text: "Create Lunch tomorrow at 3 PM UTC for one hour.",
      createdAt: "2050-08-03T22:00:00Z",
      start: "2050-08-04T15:00:00Z",
      end: "2050-08-04T16:00:00Z",
    });
    expect(result).toMatchObject({ success: true });
    await expectSaved("2050-08-04T15:00:00Z", "2050-08-04T16:00:00Z");
  });

  it("does not turn date-only extraction into a native-planner guessed time", async () => {
    const result = await create({
      text: "Create Lunch on August 4, 2050.",
      plannerStart: "2050-08-04T15:00:00Z",
    });
    expect(result).toMatchObject({
      success: false,
      data: { requiresInput: true, missing: ["startAt"] },
    });
    expect(await rows()).toEqual([]);
  });

  it("keeps an explicit post-transition civil time on the stated DST day", async () => {
    const result = await create({
      text: "Create Lunch on March 14, 2027 at 3:30 AM America/New_York for one hour.",
      zone: "America/New_York",
      start: "2027-03-14T03:30:00",
      end: "2027-03-14T04:30:00",
    });
    expect(result).toMatchObject({ success: true });
    await expectSaved(
      "2027-03-14T07:30:00Z",
      "2027-03-14T08:30:00Z",
      "America/New_York",
    );
  });

  it("leaves offset-bearing structured API timestamps authoritative", async () => {
    await service.createCalendarEvent(URL_, {
      title: "Lunch",
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      startAt: "2050-08-04T15:00:00-04:00",
      endAt: "2050-08-04T16:00:00-04:00",
      timeZone: "America/New_York",
    });
    await expectSaved(
      "2050-08-04T19:00:00Z",
      "2050-08-04T20:00:00Z",
      "America/New_York",
    );
  });

  it("rejects an impossible structured date without persisting a normalized replacement", async () => {
    await expect(
      service.createCalendarEvent(URL_, {
        title: "Lunch",
        grantId: ELIZA_CALENDAR_GRANT_ID,
        calendarId: ELIZA_CALENDAR_ID,
        startAt: "2050-02-30T15:00:00",
        endAt: "2050-02-30T16:00:00",
        timeZone: "UTC",
      }),
    ).rejects.toThrow();
    expect(await rows()).toEqual([]);
  });
});
