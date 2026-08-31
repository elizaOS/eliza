/**
 * Exercises the Calendar view's server capabilities (`view-interact.ts`)
 * through a REAL CalendarService over the production PGlite schema — the same
 * seam the views route dispatches when the planner invokes `create-event` or
 * `get-events` on the calendar view. Proves honest receipts (the receipt cites
 * the durable row the feed returns), honest validation failures that never
 * touch the store, and the honest service-unavailable path.
 */

import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { RuntimeMigrator } from "@elizaos/plugin-sql/runtime-migrator";
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
import { interact, serverInteract } from "../src/view-interact.js";

const AGENT_ID = "calendar-view-interact-pglite-agent";
const TIME_ZONE = "America/Los_Angeles";

let pg: PGlite;
let service: CalendarService;

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
    createReminderPlan: async () => {},
    updateReminderPlan: async () => {},
    deleteReminderPlan: async () => {},
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => {},
  };
}

async function eventRowCount(): Promise<number> {
  const rows = await pg.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM app_calendar.life_calendar_events",
  );
  return Number(rows.rows[0]?.count ?? "-1");
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
});

afterAll(async () => {
  __testing.setNativeCalendarBridgeForTest(undefined as never);
  await pg.close();
});

describe("calendar view server capabilities (real PGlite)", {
  timeout: 30_000,
}, () => {
  it("create-event writes a durable built-in event and returns an honest applied receipt", async () => {
    const result = await interact(
      "create-event",
      {
        title: "Live demo follow-up",
        startAt: "2026-08-27T15:00",
        timeZone: TIME_ZONE,
      },
      service,
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("Live demo follow-up");
    expect(result.text).toMatch(/^Created /);

    const data = result.data as { event: Record<string, unknown> };
    expect(data.event).toMatchObject({
      provider: "eliza",
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      title: "Live demo follow-up",
    });
    // Default duration: 60 minutes.
    const startMs = Date.parse(String(data.event.startAt));
    const endMs = Date.parse(String(data.event.endAt));
    expect(endMs - startMs).toBe(60 * 60 * 1000);

    // The receipt cites the exact durable row.
    expect(result.effectReceipts).toHaveLength(1);
    const receipt = result.effectReceipts?.[0];
    expect(receipt).toMatchObject({
      operation: "calendar.event.create",
      outcome: "applied",
      resource: { kind: "calendar.event", id: data.event.id },
    });
    expect(result.userFacingEffectReceiptIds).toEqual([receipt?.receiptId]);
    expect(await eventRowCount()).toBe(1);

    // The unified feed — the same read the view renders — returns the event.
    const readBack = await interact(
      "get-events",
      { date: "2026-08-27", timeZone: TIME_ZONE },
      service,
    );
    expect(readBack.success).toBe(true);
    expect(readBack.text).toContain("Live demo follow-up");
    const readData = readBack.data as {
      events: Array<{ id: unknown }>;
      state: unknown;
    };
    expect(readData.state).toBe("complete");
    expect(readData.events.map((event) => event.id)).toEqual([data.event.id]);
  });

  it("get-events reports an empty day honestly", async () => {
    const result = await interact(
      "get-events",
      { date: "2026-08-28", timeZone: TIME_ZONE },
      service,
    );
    expect(result.success).toBe(true);
    expect(result.text).toMatch(/No events/);
    expect(result.effectReceipts).toBeUndefined();
  });

  it("validates params honestly without touching the store", async () => {
    const missingTitle = await interact(
      "create-event",
      { startAt: "2026-08-27T15:00", timeZone: TIME_ZONE },
      service,
    );
    expect(missingTitle).toMatchObject({
      success: false,
      error: { code: "CALENDAR_VIEW_VALIDATION_FAILED" },
    });
    expect(missingTitle.text).toContain("title");

    const missingStart = await interact(
      "create-event",
      { title: "No time", timeZone: TIME_ZONE },
      service,
    );
    expect(missingStart).toMatchObject({
      success: false,
      error: { code: "CALENDAR_VIEW_VALIDATION_FAILED" },
    });
    expect(missingStart.text).toContain("startAt");

    const badDuration = await interact(
      "create-event",
      {
        title: "Zero minutes",
        startAt: "2026-08-27T15:00",
        durationMinutes: 0,
        timeZone: TIME_ZONE,
      },
      service,
    );
    expect(badDuration).toMatchObject({
      success: false,
      error: { code: "CALENDAR_VIEW_VALIDATION_FAILED" },
    });

    const unknownField = await interact(
      "create-event",
      {
        title: "Sneaky",
        startAt: "2026-08-27T15:00",
        attendees: [{ email: "x@example.com" }],
      },
      service,
    );
    expect(unknownField).toMatchObject({
      success: false,
      error: { code: "CALENDAR_VIEW_VALIDATION_FAILED" },
    });

    expect(await eventRowCount()).toBe(0);
  });

  it("refuses provider targeting with an honest pointer at the approval flow", async () => {
    const result = await interact(
      "create-event",
      {
        title: "Board sync",
        startAt: "2026-08-27T15:00",
        grantId: "google:connector-account:abc",
      },
      service,
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: "CALENDAR_VIEW_VALIDATION_FAILED" },
    });
    expect(result.text).toMatch(/built-in/i);
    expect(result.text).toMatch(/approval/i);
    expect(await eventRowCount()).toBe(0);
  });

  it("surfaces service-level 4xx refusals as honest failure text", async () => {
    const result = await interact(
      "create-event",
      { title: "Bad start", startAt: "not-a-date" },
      service,
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toBeTruthy();
    expect(result.text).toBe(result.error?.message);
    expect(await eventRowCount()).toBe(0);
  });

  it("escalates unknown capabilities to the route boundary", async () => {
    await expect(
      interact("delete-event", { id: "anything" }, service),
    ).rejects.toMatchObject({ code: "CALENDAR_VIEW_UNKNOWN_CAPABILITY" });
  });

  it("reports honest unavailability when no calendar service is resolvable", async () => {
    const direct = await interact(
      "create-event",
      { title: "Orphan", startAt: "2026-08-27T15:00" },
      null,
    );
    expect(direct).toMatchObject({
      success: false,
      error: { code: "CALENDAR_VIEW_SERVICE_UNAVAILABLE" },
    });

    const viaAdapter = await serverInteract("get-events", {}, undefined);
    expect(viaAdapter).toMatchObject({
      success: false,
      error: { code: "CALENDAR_VIEW_SERVICE_UNAVAILABLE" },
    });
  });

  it("serverInteract resolves the runtime's calendar service", async () => {
    const runtime = {
      getService: (serviceType: string) =>
        serviceType === CalendarService.serviceType ? service : null,
    } as unknown as IAgentRuntime;
    const result = await serverInteract(
      "create-event",
      {
        title: "Adapter-created event",
        startAt: "2026-08-27T09:30",
        durationMinutes: 30,
        timeZone: TIME_ZONE,
      },
      { runtime },
    );
    expect(result.success).toBe(true);
    expect(await eventRowCount()).toBe(1);
  });
});
