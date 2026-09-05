/**
 * Create requests anchor planner timestamps to the owner's zone: offset-less
 * values are wall time in the configured TIMEZONE, a fabricated "Z" or a wrong
 * day is corrected from the user's own words, and the stored event carries that
 * zone so replies render in it. CalendarService is stubbed with the real
 * range resolver; the request handed to prepareCalendarEventCreate and the
 * created event are inspected. Clock pinned to Saturday 2026-09-05 so
 * "tuesday" resolves to 2026-09-08. No model, no database.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import type {
  CreateLifeOpsCalendarEventRequest,
  LifeOpsCalendarEvent,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CalendarActionDeps,
  createCalendarActionRunner,
} from "../src/index.js";
import { resolveCalendarEventRange } from "../src/internal/calendar-normalize.js";
import { resolveDefaultTimeZone } from "../src/internal/constants.js";
import {
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_ID,
} from "../src/internal/eliza-calendar.js";

/** Saturday 2026-09-05, 11:00 in America/Los_Angeles. */
const PINNED_NOW = new Date("2026-09-05T18:00:00.000Z");
const OWNER_TIME_ZONE = "America/Los_Angeles";
/** Tuesday 2026-09-08, 7:00 AM PDT. */
const TUESDAY_7AM_PDT = "2026-09-08T14:00:00.000Z";
const TUESDAY_8AM_PDT = "2026-09-08T15:00:00.000Z";

function utcEvent(externalId: string, startAt: string): LifeOpsCalendarEvent {
  return {
    id: `agent-1:eliza:owner:grant:eliza-calendar:calendar:primary:${externalId}`,
    externalId,
    agentId: "agent-1",
    provider: "eliza",
    side: "owner",
    calendarId: "primary",
    title: "Gym session",
    description: "",
    location: "",
    status: "confirmed",
    startAt,
    endAt: new Date(Date.parse(startAt) + 60 * 60 * 1000).toISOString(),
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: { etag: '"eliza-1"', version: 1 },
    syncedAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    grantId: ELIZA_CALENDAR_GRANT_ID,
  };
}

function stubService(feedEvents: LifeOpsCalendarEvent[] = []) {
  return {
    getCalendarFeed: vi.fn(async () => ({
      calendarId: "all",
      events: feedEvents,
      source: "cache" as const,
      state: "complete" as const,
      sources: [{ status: "fresh" as const }],
      timeMin: "2026-09-05T00:00:00.000Z",
      timeMax: "2026-09-19T00:00:00.000Z",
      syncedAt: null,
    })),
    prepareCalendarEventCreate: vi.fn(
      async (_url: URL, request: CreateLifeOpsCalendarEventRequest) => {
        const range = resolveCalendarEventRange(request, new Date());
        return {
          ...request,
          side: "owner" as const,
          grantId: ELIZA_CALENDAR_GRANT_ID,
          calendarId: ELIZA_CALENDAR_ID,
          startAt: range.startAt,
          endAt: range.endAt,
          timeZone: range.timeZone,
        };
      },
    ),
    createCalendarEvent: vi.fn(
      async (
        _url: URL,
        request: CreateLifeOpsCalendarEventRequest & {
          startAt: string;
          endAt: string;
          timeZone: string;
        },
      ): Promise<LifeOpsCalendarEvent> => ({
        ...utcEvent("created", request.startAt),
        title: request.title,
        endAt: request.endAt,
        timezone: request.timeZone,
      }),
    ),
  };
}

type StubService = ReturnType<typeof stubService>;

const deps: CalendarActionDeps = {
  runTextModel: async () => null,
  runJsonModel: async () => null,
  recentConversationTexts: async () => [],
};

function fakeRuntime(
  service: StubService,
  settings: Record<string, string>,
): IAgentRuntime {
  return {
    agentId: "agent-1",
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    reportError: vi.fn(),
    getSetting: (key: string) => settings[key],
    getService: (name: string) => (name === "calendar" ? service : null),
  } as unknown as IAgentRuntime;
}

async function createThroughHandler(args: {
  text: string;
  details: Record<string, unknown>;
  settings?: Record<string, string>;
  feedEvents?: LifeOpsCalendarEvent[];
}) {
  const service = stubService(args.feedEvents);
  const action = createCalendarActionRunner(deps);
  const result = await action.handler(
    fakeRuntime(service, args.settings ?? { TIMEZONE: OWNER_TIME_ZONE }),
    {
      id: "00000000-0000-0000-0000-000000000301",
      entityId: "00000000-0000-0000-0000-000000000302",
      roomId: "00000000-0000-0000-0000-000000000303",
      content: { text: args.text },
    } as unknown as Memory,
    undefined,
    {
      parameters: {
        subaction: "create_event",
        title: "Gym session",
        details: args.details,
      },
    },
    vi.fn(async () => []),
  );
  if (!result) throw new Error("Expected a Calendar action result");
  expect(service.createCalendarEvent).toHaveBeenCalledTimes(1);
  const [, created] = service.createCalendarEvent.mock.calls[0] as unknown as [
    URL,
    { startAt: string; endAt: string; timeZone: string },
  ];
  return { result, created };
}

describe("calendar create anchors planner timestamps to the owner's zone", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["offset-less wall time", "2026-09-08T07:00:00", "2026-09-08T08:00:00"],
    ["wall time without seconds", "2026-09-08T07:00", "2026-09-08T08:00"],
    [
      "a fabricated Z on the right digits",
      "2026-09-08T07:00:00.000Z",
      "2026-09-08T08:00:00.000Z",
    ],
    [
      "a fabricated Z on the wrong day",
      "2026-09-09T07:00:00Z",
      "2026-09-09T08:00:00Z",
    ],
    [
      "the wrong date as wall time",
      "2026-09-01T07:00:00",
      "2026-09-01T08:00:00",
    ],
    [
      "a correct explicit offset",
      "2026-09-08T07:00:00-07:00",
      "2026-09-08T08:00:00-07:00",
    ],
  ])(
    "stores 'tuesday at 7am' at 7 AM Pacific when the planner sends %s",
    async (_label, start, end) => {
      // Live 2026-09-05: every one of these shapes was recorded for the same
      // request; four of them were stored at 07:00Z and read back as 7 AM UTC.
      const { result, created } = await createThroughHandler({
        text: "add gym session tuesday at 7am to my calendar",
        details: { start, end, calendarId: "primary" },
      });
      expect(created).toMatchObject({
        startAt: TUESDAY_7AM_PDT,
        endAt: TUESDAY_8AM_PDT,
        timeZone: OWNER_TIME_ZONE,
      });
      // The action hands internal evidence to the evaluator (no user text of
      // its own); the rendered time in that evidence must carry the zone.
      const evidence = JSON.stringify(result.data ?? {}) + (result.text ?? "");
      expect(evidence).toContain("7:00 AM PDT");
      expect(evidence).not.toContain("AM UTC");
    },
  );

  it("keeps the configured zone when the feed is full of UTC-stamped events", async () => {
    const feedEvents = [
      utcEvent("a", "2026-09-08T07:00:00.000Z"),
      utcEvent("b", "2026-09-08T07:00:00.000Z"),
      utcEvent("c", "2026-09-08T14:00:00.000Z"),
    ];
    const { created } = await createThroughHandler({
      text: "add gym session tuesday at 7am to my calendar",
      details: { start: "2026-09-08T07:00:00" },
      feedEvents,
    });
    expect(created.timeZone).toBe(OWNER_TIME_ZONE);
    expect(created.startAt).toBe(TUESDAY_7AM_PDT);
  });

  it("ignores planner junk in timeZone and still creates in the owner's zone", async () => {
    const { created } = await createThroughHandler({
      text: "add gym session tuesday at 7am to my calendar",
      details: {
        start: "2026-09-08T07:00:00",
        timeZone: "user's timezone",
      },
    });
    expect(created).toMatchObject({
      startAt: TUESDAY_7AM_PDT,
      timeZone: OWNER_TIME_ZONE,
    });
  });

  it("honours a real zone the planner names", async () => {
    const { created } = await createThroughHandler({
      text: "add gym session tuesday at 7am to my calendar",
      details: { start: "2026-09-08T07:00:00", timeZone: "America/New_York" },
    });
    expect(created).toMatchObject({
      startAt: "2026-09-08T11:00:00.000Z",
      timeZone: "America/New_York",
    });
  });

  it("drops an end that echoes the start so the default duration applies", async () => {
    const { created } = await createThroughHandler({
      text: "add gym session tuesday at 7am to my calendar",
      details: { start: "2026-09-08T07:00:00", end: "2026-09-08T07:00:00" },
    });
    expect(created).toMatchObject({
      startAt: TUESDAY_7AM_PDT,
      endAt: TUESDAY_8AM_PDT,
    });
  });

  it("leaves the planner's instant alone when the user named two different times", async () => {
    const { created } = await createThroughHandler({
      text: "add a call with bob at 3pm and remind me at 2pm on tuesday",
      details: { start: "2026-09-08T15:00:00Z", end: "2026-09-08T16:00:00Z" },
    });
    expect(created.startAt).toBe("2026-09-08T15:00:00.000Z");
  });

  it("falls back to the host zone when no TIMEZONE is configured", async () => {
    const hostZone = resolveDefaultTimeZone();
    const { created } = await createThroughHandler({
      text: "add gym session tuesday at 7am to my calendar",
      details: { start: "2026-09-08T07:00:00" },
      settings: {},
    });
    expect(created.timeZone).toBe(hostZone);
    expect(
      new Intl.DateTimeFormat("en-US", {
        timeZone: hostZone,
        hour: "numeric",
        hour12: false,
      }).format(new Date(created.startAt)),
    ).toBe("07");
  });
});
