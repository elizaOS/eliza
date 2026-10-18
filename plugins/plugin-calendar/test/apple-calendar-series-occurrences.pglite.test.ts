/**
 * EventKit gives every occurrence of a recurring series the same identifier.
 * The Apple Calendar sync must still store one row per occurrence, and update
 * and delete must still send EventKit its own identifier. Real CalendarService
 * Apple sync and repository on PGlite; the native bridge is a stub.
 */
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { RuntimeMigrator } from "@elizaos/plugin-sql";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  __testing,
  deleteNativeAppleCalendarEvent,
} from "../src/apple-calendar.ts";
import { CalendarService, calendarSchema } from "../src/service/index.ts";

const AGENT_ID = "00000000-0000-4000-8000-0000000000a1";
let pg: PGlite;
let service: CalendarService;
const deletedIds: string[] = [];

const occurrence = (day: string) => ({
  id: "SERIES-ABC",
  externalId: "SERIES-ABC",
  calendarId: "work",
  title: "Weekly standup",
  startAt: `${day}T16:00:00.000Z`,
  endAt: `${day}T16:30:00.000Z`,
  isAllDay: false,
  originalStartAt: `${day}T16:00:00.000Z`,
  recurrenceRules: [{ frequency: "weekly", interval: 1 }],
});

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
    getSetting: () => undefined,
    getService: () => null,
    reportError: async () => {},
  } as unknown as IAgentRuntime;
  service = new CalendarService(runtime);
  __testing.setNativeCalendarBridgeForTest({
    listEvents: async () => ({
      ok: true,
      events: [
        occurrence("2026-10-19"),
        occurrence("2026-10-26"),
        occurrence("2026-11-02"),
      ],
    }),
    deleteEvent: async (eventId: string) => {
      deletedIds.push(eventId);
      return { ok: true };
    },
  } as never);
}, 30_000);

afterAll(async () => {
  __testing.setNativeCalendarBridgeForTest(undefined as never);
  await pg.close();
});

it("stores every occurrence of an Apple series and deletes by the EventKit id", async () => {
  const feed = await (
    service as unknown as {
      syncAppleCalendarFeed(args: Record<string, string>): Promise<{
        events: Array<{ externalId: string; startAt: string }>;
      }>;
    }
  ).syncAppleCalendarFeed({
    calendarId: "work",
    calendarSummary: "Work",
    calendarAccessRole: "owner",
    timeMin: "2026-10-18T00:00:00.000Z",
    timeMax: "2026-11-08T00:00:00.000Z",
    timeZone: "UTC",
  });

  const rows = await pg.query<{ start_at: string }>(
    `SELECT start_at FROM app_calendar.life_calendar_events
      WHERE provider = 'apple_calendar' ORDER BY start_at ASC`,
  );
  expect(rows.rows.map((row) => row.start_at)).toEqual([
    "2026-10-19T16:00:00.000Z",
    "2026-10-26T16:00:00.000Z",
    "2026-11-02T16:00:00.000Z",
  ]);

  const target = feed.events.find(
    (event) => event.startAt === "2026-10-26T16:00:00.000Z",
  );
  if (!target) throw new Error("occurrence missing from the feed");
  await deleteNativeAppleCalendarEvent(target.externalId);
  expect(deletedIds).toEqual(["SERIES-ABC"]);
});
