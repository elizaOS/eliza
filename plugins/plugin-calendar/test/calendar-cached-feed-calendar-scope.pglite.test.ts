import { PGlite } from "@electric-sql/pglite";
import type {
  LifeOpsConnectorGrant,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/contracts";
import type { IAgentRuntime } from "@elizaos/core";
import { RuntimeMigrator } from "@elizaos/plugin-sql";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __testing as appleCalendarTesting } from "../src/apple-calendar.js";
import {
  type CalendarHostGate,
  CalendarService,
  calendarSchema,
} from "../src/service/index.js";

const AGENT_ID = "calendar-cached-feed-scope-agent";
const INTERNAL_URL = new URL("http://internal.local/api/calendar");
const HOUR_MS = 60 * 60 * 1000;
const WINDOW_START_MS = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
const TIME_MIN = new Date(WINDOW_START_MS).toISOString();
const TIME_MAX = new Date(WINDOW_START_MS + 24 * HOUR_MS).toISOString();
const HOLIDAYS = "holidays@group.v.calendar.google.com";

const GRANT: LifeOpsConnectorGrant = {
  id: "connector-account:account-a",
  agentId: AGENT_ID,
  provider: "google",
  connectorAccountId: "account-a",
  side: "owner",
  identity: { email: "account-a@example.test" },
  identityEmail: "account-a@example.test",
  grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  capabilities: ["google.calendar.read"],
  tokenRef: null,
  mode: "local",
  executionTarget: "local",
  sourceOfTruth: "connector_account",
  preferredByAgent: false,
  cloudConnectionId: null,
  metadata: {},
  lastRefreshAt: "2026-07-26T00:00:00.000Z",
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
};

const STATUS: LifeOpsGoogleConnectorStatus = {
  provider: "google",
  side: "owner",
  mode: "local",
  defaultMode: "local",
  availableModes: ["local"],
  executionTarget: "local",
  sourceOfTruth: "connector_account",
  configured: true,
  connected: true,
  reason: "connected",
  preferredByAgent: false,
  cloudConnectionId: null,
  identity: GRANT.identity,
  grantedCapabilities: ["google.calendar.read"],
  grantedScopes: [...GRANT.grantedScopes],
  expiresAt: null,
  hasRefreshToken: true,
  grant: GRANT,
};

function providerCalendar(calendarId: string, summary: string) {
  return {
    calendarId,
    summary,
    description: null,
    primary: calendarId === "primary",
    accessRole: "owner",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: "UTC",
    selected: true,
  };
}

function providerEvent(calendarId: string) {
  return {
    id: calendarId === "primary" ? "standup" : "holiday",
    calendarId,
    title: calendarId === "primary" ? "Standup" : "Hidden holiday",
    status: "confirmed",
    start: new Date(
      WINDOW_START_MS + (calendarId === "primary" ? 2 : 5) * HOUR_MS,
    ).toISOString(),
    end: new Date(
      WINDOW_START_MS + (calendarId === "primary" ? 3 : 6) * HOUR_MS,
    ).toISOString(),
    isAllDay: false,
    timeZone: "UTC",
    htmlLink: null,
    meetLink: null,
    attendees: [],
    location: "",
    description: "",
    organizer: null,
    recurrence: null,
    recurringEventId: null,
    metadata: {},
  };
}

let pg: PGlite;
let calendar: CalendarService;
const eventPageRequests: string[] = [];

beforeAll(async () => {
  appleCalendarTesting.setMacCalendarBridgeForTest(null);
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
    getCache: async () => undefined,
    setCache: async () => undefined,
    reportError: () => undefined,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    getService: (name: string) =>
      name === "calendar"
        ? calendar
        : name === "google"
          ? {
              listCalendars: async () => [
                providerCalendar("primary", "Primary"),
                providerCalendar(HOLIDAYS, "Holidays"),
              ],
              listEventPage: async (request: { calendarId: string }) => {
                eventPageRequests.push(request.calendarId);
                return {
                  events: [providerEvent(request.calendarId)],
                  nextPageToken: null,
                  nextSyncToken: null,
                };
              },
            }
          : null,
  } as unknown as IAgentRuntime;

  const gate = {
    getGoogleConnectorAccounts: async () => [STATUS],
    requireGoogleCalendarGrant: async () => GRANT,
    requireGoogleCalendarWriteGrant: async () => GRANT,
    createReminderPlan: async () => undefined,
    updateReminderPlan: async () => undefined,
    deleteReminderPlan: async () => undefined,
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => undefined,
  } as unknown as CalendarHostGate;

  calendar = new CalendarService(runtime);
  calendar.setGate(gate);
});

beforeEach(async () => {
  eventPageRequests.length = 0;
  await pg.query("DELETE FROM app_calendar.life_calendar_events");
  await pg.query("DELETE FROM app_calendar.life_calendar_sync_states");
  await pg.query("DELETE FROM app_calendar.life_calendar_feed_preferences");
});

afterAll(async () => {
  appleCalendarTesting.resetMacCalendarBridgeForTest();
  await pg.close();
});

async function showPrimaryAndCacheBothCalendars() {
  await calendar.setCalendarIncluded(INTERNAL_URL, {
    provider: "google",
    side: "owner",
    grantId: GRANT.id,
    connectorAccountId: GRANT.connectorAccountId,
    calendarId: "primary",
    includeInFeed: true,
    expectedVersion: 0,
  });
  const listed = await calendar.listCalendars(INTERNAL_URL);
  expect(
    listed
      .filter((entry) => entry.provider === "google")
      .map((entry) => [entry.calendarId, entry.includeInFeed]),
  ).toEqual([
    ["primary", true],
    [HOLIDAYS, false],
  ]);
  const synced = await calendar.getCalendarFeed(INTERNAL_URL, {
    timeMin: TIME_MIN,
    timeMax: TIME_MAX,
    includeHiddenCalendars: true,
    forceSync: true,
  });
  expect(eventPageRequests.sort()).toEqual([HOLIDAYS, "primary"]);
  expect(synced.events.map((event) => event.title).sort()).toEqual([
    "Hidden holiday",
    "Standup",
  ]);
  eventPageRequests.length = 0;
}

describe("cached calendar feed reads stay scoped to the requested calendar", {
  timeout: 30_000,
}, () => {
  it("excludes a hidden calendar's events from the default cached feed", async () => {
    await showPrimaryAndCacheBothCalendars();

    const feed = await calendar.getCalendarFeed(INTERNAL_URL, {
      timeMin: TIME_MIN,
      timeMax: TIME_MAX,
    });

    expect(eventPageRequests).toEqual([]);
    expect(feed.source).toBe("cache");
    expect(feed.events.map((event) => event.title)).toEqual(["Standup"]);
  });

  it("returns only the requested calendar's events on an explicit cached read", async () => {
    await showPrimaryAndCacheBothCalendars();

    const feed = await calendar.getCalendarFeed(INTERNAL_URL, {
      calendarId: "primary",
      timeMin: TIME_MIN,
      timeMax: TIME_MAX,
    });

    expect(eventPageRequests).toEqual([]);
    expect(feed.source).toBe("cache");
    expect(feed.events.map((event) => event.title)).toEqual(["Standup"]);
  });
});
