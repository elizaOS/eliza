/**
 * A managed owner Calendar host declares which of the owner's calendars its
 * product shows. Real PGlite rows prove that the one aggregate feed then holds
 * the built-in calendar and those calendars (deduplicated), that rows seeded
 * under an earlier hidden default follow the host, and that an explicit owner
 * choice is kept.
 */
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { RuntimeMigrator } from "@elizaos/plugin-sql";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { __testing } from "../src/apple-calendar.js";
import {
  type CalendarHostGate,
  CalendarService,
  calendarSchema,
} from "../src/service/index.js";

const AGENT_ID = "calendar-managed-default-agent";
const INTERNAL_URL = new URL("http://internal.local/api/calendar");
const GRANT = `alpha-google:${"b".repeat(64)}`;
const WINDOW = {
  timeMin: "2026-10-30T00:00:00.000Z",
  timeMax: "2026-10-31T00:00:00.000Z",
  timeZone: "UTC",
};
const SYNCED_AT = "2026-10-30T00:00:00.000Z";

type HostCalendar = { calendarId: string; summary: string; primary?: true };
/** What Alpha's host lists: every readable calendar, shown or not in Google. */
const CALENDARS: readonly HostCalendar[] = [
  { calendarId: "owner@example.test", summary: "Owner", primary: true },
  { calendarId: "team@group.calendar.google.com", summary: "Team" },
  { calendarId: "birthdays", summary: "Birthdays" },
];

let pg: PGlite;
let runtime: IAgentRuntime;
let shown = new Set<string>();
const feedReads: string[] = [];

function event(calendarId: string, externalId: string, title: string) {
  const hour = externalId === "standup" ? 9 : 14;
  const at = (h: number) =>
    `2026-10-30T${String(h).padStart(2, "0")}:00:00.000Z`;
  return {
    externalId,
    calendarId,
    title,
    description: "",
    location: "",
    status: "confirmed",
    startAt: at(hour),
    endAt: at(hour + 1),
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    // One invitation on two of the owner's calendars carries one iCalUID.
    metadata: { iCalUID: `${externalId}@example.test` },
    id: `${GRANT}:${calendarId}:${externalId}`,
    agentId: "",
    provider: "google",
    side: "owner",
    grantId: GRANT,
    connectorAccountId: GRANT,
    syncedAt: SYNCED_AT,
    updatedAt: SYNCED_AT,
  };
}

const EVENTS: Record<string, ReturnType<typeof event>[]> = {
  "owner@example.test": [
    event("owner@example.test", "standup", "Standup"),
    event("owner@example.test", "launch", "Launch review"),
  ],
  "team@group.calendar.google.com": [
    event("team@group.calendar.google.com", "launch", "Launch review"),
  ],
  birthdays: [event("birthdays", "birthday", "Birthday")],
};

function broker(input: Record<string, string>, listed = CALENDARS) {
  if (input.operation === "sources") {
    return {
      calendars: listed.map((calendar) => ({
        provider: "google",
        side: "owner",
        grantId: GRANT,
        connectorAccountId: GRANT,
        accountEmail: "owner@example.test",
        description: null,
        primary: false,
        accessRole: "owner",
        backgroundColor: null,
        foregroundColor: null,
        timeZone: "UTC",
        selected: shown.has(calendar.calendarId),
        ...calendar,
        includeInFeed: shown.has(calendar.calendarId),
        selectionVersion: 1,
      })),
    };
  }
  feedReads.push(input.calendarId);
  return {
    feed: {
      calendarId: input.calendarId,
      events: EVENTS[input.calendarId] ?? [],
      source: "synced",
      state: "complete",
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      syncedAt: SYNCED_AT,
      sources: [
        {
          key: {
            provider: "google",
            side: "owner",
            grantId: GRANT,
            connectorAccountId: GRANT,
            calendarId: input.calendarId,
          },
          summary: input.calendarId,
          accessRole: "owner",
          visibility: "details",
          status: "fresh",
          syncedAt: SYNCED_AT,
          error: null,
        },
      ],
    },
  };
}

function service(
  respond: (input: Record<string, string>) => unknown = broker,
): CalendarService {
  vi.stubEnv(
    "ELIZA_MANAGED_CALENDAR_READ_BROKER",
    "http://127.0.0.1:1/__alpha-owner-gmail",
  );
  vi.stubEnv("ELIZA_API_TOKEN", "a".repeat(64));
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    const reply = await respond(JSON.parse(String(init.body)).calendar);
    return reply instanceof Response ? reply : Response.json(reply);
  });
  const calendar = new CalendarService(runtime);
  calendar.setGate({
    getGoogleConnectorAccounts: async () => [],
    createReminderPlan: async () => {},
    updateReminderPlan: async () => {},
    deleteReminderPlan: async () => {},
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => {},
  } as unknown as CalendarHostGate);
  return calendar;
}

async function managedIncludes(calendar: CalendarService) {
  return (await calendar.listCalendars(INTERNAL_URL))
    .filter((source) => source.grantId === GRANT)
    .map((source) => [source.calendarId, source.includeInFeed]);
}

beforeAll(async () => {
  __testing.setMacCalendarBridgeForTest(null);
  pg = new PGlite();
  const db = drizzle(pg);
  await new RuntimeMigrator(db).migrate(
    "@elizaos/plugin-calendar",
    calendarSchema,
  );
  runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    db,
    initPromise: Promise.resolve(),
    getCache: async () => undefined,
    setCache: async () => undefined,
    getSetting: () => undefined,
    getService: () => null,
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
}, 30_000);

beforeEach(async () => {
  feedReads.length = 0;
  shown = new Set(["owner@example.test", "team@group.calendar.google.com"]);
  await pg.query("DELETE FROM app_calendar.life_calendar_events");
  await pg.query("DELETE FROM app_calendar.life_calendar_feed_preferences");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  __testing.resetMacCalendarBridgeForTest();
  await pg.close();
});

describe("managed owner calendars in the aggregate feed", {
  timeout: 30_000,
}, () => {
  it("merges the built-in calendar with every calendar the host shows, once each", async () => {
    const calendar = service();
    await calendar.createCalendarEvent(INTERNAL_URL, {
      grantId: "eliza-calendar",
      calendarId: "primary",
      title: "Dentist",
      startAt: "2026-10-30T11:00:00.000Z",
      endAt: "2026-10-30T12:00:00.000Z",
      timeZone: "UTC",
      idempotencyKey: "managed-default-local-event",
    });

    expect(await managedIncludes(calendar)).toEqual([
      ["owner@example.test", true],
      ["team@group.calendar.google.com", true],
      ["birthdays", false],
    ]);
    const feed = await calendar.getCalendarFeed(INTERNAL_URL, WINDOW);

    expect(feed.state).toBe("complete");
    expect(feedReads.sort()).toEqual([
      "owner@example.test",
      "team@group.calendar.google.com",
    ]);
    expect(feed.events.map((entry) => entry.title).sort()).toEqual([
      "Dentist",
      "Launch review",
      "Standup",
    ]);
  });

  it("applies the host default to rows seeded hidden and keeps an owner's choice", async () => {
    const calendar = service();
    shown = new Set();
    expect(await managedIncludes(calendar)).toEqual([
      ["owner@example.test", false],
      ["team@group.calendar.google.com", false],
      ["birthdays", false],
    ]);

    shown = new Set(["owner@example.test", "team@group.calendar.google.com"]);
    expect(await managedIncludes(calendar)).toEqual([
      ["owner@example.test", true],
      ["team@group.calendar.google.com", true],
      ["birthdays", false],
    ]);

    await calendar.setCalendarIncluded(INTERNAL_URL, {
      provider: "google",
      side: "owner",
      grantId: GRANT,
      connectorAccountId: GRANT,
      calendarId: "team@group.calendar.google.com",
      includeInFeed: false,
      expectedVersion: 0,
    });
    expect(await managedIncludes(calendar)).toEqual([
      ["owner@example.test", true],
      ["team@group.calendar.google.com", false],
      ["birthdays", false],
    ]);
    const feed = await calendar.getCalendarFeed(INTERNAL_URL, WINDOW);
    expect(feed.events.map((entry) => entry.title).sort()).toEqual([
      "Launch review",
      "Standup",
    ]);
  });
});

describe("managed owner feeds in one aggregate read", {
  timeout: 30_000,
}, () => {
  const managedOrder = (feed: { sources: { key: Record<string, string> }[] }) =>
    feed.sources
      .filter((source) => source.key.grantId === GRANT)
      .map((source) => source.key.calendarId);

  it("reads at most four managed calendars at once and keeps calendar order", async () => {
    const listed = Array.from({ length: 6 }, (_, index) => ({
      calendarId: `team-${index}@group.calendar.google.com`,
      summary: `Team ${index}`,
    }));
    shown = new Set(listed.map((entry) => entry.calendarId));
    const started: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const calendar = service(async (input) => {
      if (input.operation !== "feed") return broker(input, listed);
      started.push(input.calendarId);
      peak = Math.max(peak, ++inFlight);
      // Earlier calendars answer last.
      const index = listed.findIndex((e) => e.calendarId === input.calendarId);
      await new Promise((done) =>
        setTimeout(done, (listed.length - index) * 15),
      );
      inFlight--;
      return broker(input, listed);
    });

    const feed = await calendar.getCalendarFeed(INTERNAL_URL, WINDOW);

    expect(peak).toBe(4);
    expect(started).toEqual(listed.map((entry) => entry.calendarId));
    expect(feed.state).toBe("complete");
    expect(managedOrder(feed)).toEqual(listed.map((entry) => entry.calendarId));
  });

  it("degrades and reports one failed managed calendar on its own", async () => {
    shown = new Set(CALENDARS.map((entry) => entry.calendarId));
    const reported = vi.spyOn(runtime, "reportError");
    const calendar = service(async (input) => {
      if (input.calendarId === "owner@example.test")
        await new Promise((done) => setTimeout(done, 30));
      if (input.calendarId === "team@group.calendar.google.com")
        return Response.json({ error: "refused" }, { status: 409 });
      return broker(input);
    });

    const feed = await calendar.getCalendarFeed(INTERNAL_URL, WINDOW);

    expect(feed.state).toBe("partial");
    expect(managedOrder(feed)).toEqual(CALENDARS.map((e) => e.calendarId));
    expect(
      feed.sources
        .filter((source) => source.key.grantId === GRANT)
        .map((source) => [source.status, source.error?.code ?? null]),
    ).toEqual([
      ["fresh", null],
      ["error", "MANAGED_CALENDAR_READ_UNAVAILABLE"],
      ["fresh", null],
    ]);
    expect(feed.events.map((entry) => entry.title).sort()).toEqual([
      "Birthday",
      "Launch review",
      "Standup",
    ]);
    expect(
      reported.mock.calls
        .filter(([scope]) => scope === "calendar:feed-managed-source")
        .map(
          ([, , context]) =>
            (context as { source: { calendarId: string } }).source.calendarId,
        ),
    ).toEqual(["team@group.calendar.google.com"]);
    reported.mockRestore();
  });
});
