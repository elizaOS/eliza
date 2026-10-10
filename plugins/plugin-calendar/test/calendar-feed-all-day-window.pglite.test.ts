import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { RuntimeMigrator } from "@elizaos/plugin-sql";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type CalendarHostGate,
  CalendarService,
  calendarSchema,
} from "../src/service/index.js";

const AGENT_ID = "all-day-window-agent";
const INTERNAL_URL = new URL("http://internal.local/api/calendar");
const GRANT = {
  id: "connector-account:acct-a",
  agentId: AGENT_ID,
  provider: "google",
  connectorAccountId: "acct-a",
  side: "owner",
  identity: { email: "owner@example.com" },
  identityEmail: "owner@example.com",
  grantedScopes: [],
  capabilities: ["google.calendar.read"],
  tokenRef: null,
  mode: "local",
  executionTarget: "local",
  sourceOfTruth: "connector_account",
  preferredByAgent: false,
  cloudConnectionId: null,
  metadata: {},
  lastRefreshAt: "2026-06-01T00:00:00.000Z",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

function googleEvent(args: {
  id: string;
  title: string;
  start: string;
  end: string;
  isAllDay: boolean;
}) {
  return {
    id: args.id,
    calendarId: "primary",
    title: args.title,
    status: "confirmed",
    start: args.start,
    end: args.end,
    isAllDay: args.isAllDay,
    timeZone: "UTC",
    htmlLink: null,
    meetLink: null,
    attendees: [],
    location: "",
    description: "",
    organizer: null,
    metadata: {},
  };
}

const PROVIDER_EVENTS = [
  googleEvent({
    id: "all-day-jun-2",
    title: "Jun 2 offsite",
    start: "2026-06-02T00:00:00.000Z",
    end: "2026-06-03T00:00:00.000Z",
    isAllDay: true,
  }),
  googleEvent({
    id: "all-day-jun-3",
    title: "Jun 3 holiday",
    start: "2026-06-03T00:00:00.000Z",
    end: "2026-06-04T00:00:00.000Z",
    isAllDay: true,
  }),
  googleEvent({
    id: "all-day-jun-4",
    title: "Jun 4 holiday",
    start: "2026-06-04T00:00:00.000Z",
    end: "2026-06-05T00:00:00.000Z",
    isAllDay: true,
  }),
  googleEvent({
    id: "timed-jun-3",
    title: "Design review",
    start: "2026-06-03T02:00:00.000Z",
    end: "2026-06-03T03:00:00.000Z",
    isAllDay: false,
  }),
];

let pg: PGlite;
let service: CalendarService;
let eventPageRequests: Array<{ syncToken?: string | null }> = [];

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
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    getCache: async () => undefined,
    setCache: async () => undefined,
    reportError: () => undefined,
    getService: (name: string) =>
      name === "google"
        ? {
            listEventPage: async (request: { syncToken?: string | null }) => {
              eventPageRequests.push({ syncToken: request.syncToken });
              return request.syncToken
                ? { events: [], nextPageToken: null, nextSyncToken: "tok-2" }
                : {
                    events: PROVIDER_EVENTS,
                    nextPageToken: null,
                    nextSyncToken: "tok-1",
                  };
            },
          }
        : null,
  } as unknown as IAgentRuntime;
  service = new CalendarService(runtime);
  const requireGrant = async () => GRANT;
  service.setGate({
    getGoogleConnectorAccounts: async () => [],
    resolveGuestAvailabilityGrants: async () => {
      throw new Error("Guest availability is outside this test.");
    },
    requireGoogleCalendarGrant: requireGrant,
    requireGoogleCalendarWriteGrant: requireGrant,
    createReminderPlan: async () => undefined,
    updateReminderPlan: async () => undefined,
    deleteReminderPlan: async () => undefined,
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => undefined,
  } as unknown as CalendarHostGate);
}, 30_000);

beforeEach(async () => {
  await pg.query("DELETE FROM app_calendar.life_calendar_events");
  await pg.query("DELETE FROM app_calendar.life_calendar_sync_states");
  eventPageRequests = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-02T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

function readFeed(args: {
  timeZone: string;
  timeMin: string;
  timeMax: string;
  forceSync?: boolean;
}) {
  return service.getCalendarFeed(
    INTERNAL_URL,
    { grantId: GRANT.id, calendarId: "primary", ...args },
    new Date(),
  );
}

describe("calendar feed all-day events on the owner's local day (real PGlite)", {
  timeout: 30_000,
}, () => {
  it("does not show tomorrow's all-day event in a cached Los Angeles today", async () => {
    await readFeed({
      timeZone: "America/Los_Angeles",
      timeMin: "2026-05-31T07:00:00.000Z",
      timeMax: "2026-06-07T07:00:00.000Z",
      forceSync: true,
    });

    const today = await readFeed({
      timeZone: "America/Los_Angeles",
      timeMin: "2026-06-03T07:00:00.000Z",
      timeMax: "2026-06-04T07:00:00.000Z",
    });

    expect(today.source).toBe("cache");
    expect(eventPageRequests).toHaveLength(1);
    expect(today.events.map((event) => event.title)).toEqual(["Jun 3 holiday"]);
  });

  it("does not show yesterday's all-day event in an incrementally synced Tokyo today", async () => {
    await readFeed({
      timeZone: "Asia/Tokyo",
      timeMin: "2026-05-30T15:00:00.000Z",
      timeMax: "2026-06-06T15:00:00.000Z",
      forceSync: true,
    });

    const today = await readFeed({
      timeZone: "Asia/Tokyo",
      timeMin: "2026-06-02T15:00:00.000Z",
      timeMax: "2026-06-03T15:00:00.000Z",
      forceSync: true,
    });

    expect(eventPageRequests.map((request) => request.syncToken)).toEqual([
      undefined,
      "tok-1",
    ]);
    expect(today.events.map((event) => event.title)).toEqual([
      "Jun 3 holiday",
      "Design review",
    ]);
  });
});
