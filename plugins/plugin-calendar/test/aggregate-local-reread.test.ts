/** Aggregated feed local reads: real method and managed reader, I/O-free ports. */
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsCalendarSummary,
} from "@elizaos/contracts";
import { type IAgentRuntime, Semaphore } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { elizaCalendarSummary } from "../src/internal/eliza-calendar.js";
import { CalendarService } from "../src/service/CalendarService.js";
import {
  createManagedCalendarRead,
  managedCalendarPlaceholder,
} from "../src/service/managed-calendar-read.js";

const timeMin = "2026-11-03T08:00:00.000Z";
const timeMax = "2026-11-04T08:00:00.000Z";
const now = new Date("2026-11-03T12:00:00.000Z");
const eliza = elizaCalendarSummary();
const managed = managedCalendarPlaceholder(`alpha-google:${"a".repeat(64)}`);
const native: LifeOpsCalendarSummary = {
  ...managedCalendarPlaceholder(),
  grantId: "google-grant",
  connectorAccountId: "google-grant",
  calendarId: "primary",
  summary: "Google",
};
const ics: LifeOpsCalendarSummary = {
  ...native,
  provider: "ics",
  grantId: "ics-source",
  connectorAccountId: "ics-source",
  calendarId: "ics-source",
};

function event(
  calendar: LifeOpsCalendarSummary,
  title: string,
): LifeOpsCalendarEvent {
  return {
    id: `${calendar.provider}:${title}`,
    externalId: title,
    agentId: "feed-owner",
    provider: calendar.provider,
    side: "owner",
    calendarId: calendar.calendarId,
    grantId: calendar.grantId,
    title,
    description: "",
    location: "",
    status: "confirmed",
    startAt: "2026-11-03T17:00:00.000Z",
    endAt: "2026-11-03T18:00:00.000Z",
    isAllDay: false,
    timezone: null,
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function fixture() {
  const reads: string[] = [];
  const broker: string[] = [];
  // Each local read of a provider returns its next snapshot: a provider sync
  // between the first and second Eliza read is visible as "eliza-2".
  const counts = new Map<string, number>();
  const request = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { calendar } = JSON.parse(String(init?.body));
    broker.push(calendar.operation);
    const health = {
      key: {
        provider: "google",
        side: "owner",
        grantId: calendar.grantId,
        connectorAccountId: calendar.grantId,
        calendarId: calendar.calendarId,
      },
      status: "fresh",
      syncedAt: now.toISOString(),
      error: null,
    };
    return Response.json({
      feed: {
        calendarId: calendar.calendarId,
        events: [event(managed, "managed")],
        source: "synced",
        state: "complete",
        sources: [health],
        timeMin: calendar.timeMin,
        timeMax: calendar.timeMax,
        syncedAt: now.toISOString(),
      },
    });
  }) as typeof fetch;
  const service = Object.create(CalendarService.prototype) as CalendarService;
  Object.assign(service, {
    runtime: {
      agentId: "feed-owner",
      reportError: () => {
        throw Error("Unexpected source failure");
      },
    } as unknown as IAgentRuntime,
    managedCalendar: createManagedCalendarRead(
      {
        ELIZA_MANAGED_CALENDAR_READ_BROKER:
          "http://127.0.0.1:1/__alpha-owner-gmail",
        ELIZA_API_TOKEN: "a".repeat(64),
      },
      request,
    ),
    managedFeedReads: new Semaphore(4),
    googleWatch: { sourceHealth: async () => undefined },
    linkedRepo: { listForAgent: async () => [] },
    repo: {
      listCalendarFeedWindowEvents: async (args: { provider: string }) => {
        const count = (counts.get(args.provider) ?? 0) + 1;
        counts.set(args.provider, count);
        reads.push(args.provider);
        const calendar = args.provider === "eliza" ? eliza : native;
        return [event(calendar, `${args.provider}-${count}`)];
      },
      getCalendarSyncState: async () => ({
        windowStartAt: timeMin,
        windowEndAt: timeMax,
        syncedAt: new Date(now.getTime() - 1_000).toISOString(),
      }),
      getIcsCalendarSource: async () => ({ enabled: false }),
    },
  });
  const aggregate = (calendars: LifeOpsCalendarSummary[]) =>
    (
      service as unknown as {
        aggregateCalendarFeedsAcrossCalendars(
          ...args: unknown[]
        ): Promise<LifeOpsCalendarFeed>;
      }
    ).aggregateCalendarFeedsAcrossCalendars(
      new URL("http://internal.local/api/calendar"),
      calendars,
      timeMin,
      timeMax,
      "UTC",
      false,
      now,
      [],
      new AbortController().signal,
    );
  return { aggregate, reads, broker };
}

const titles = (feed: LifeOpsCalendarFeed) =>
  feed.events.map((item) => item.title).sort();

describe("aggregated feed local re-read", () => {
  it.each([
    ["Eliza then managed", [eliza, managed]],
    ["managed then Eliza", [managed, eliza]],
  ])(
    "reads the local window once beside only a managed feed (%s)",
    async (_label, calendars) => {
      const { aggregate, reads, broker } = fixture();
      const feed = await aggregate(calendars);
      expect(reads).toEqual(["eliza"]);
      expect(broker).toEqual(["feed"]);
      expect(titles(feed)).toEqual(["eliza-1", "managed"]);
      expect(feed.state).toBe("complete");
      expect(feed.sources.map((source) => source.status)).toEqual([
        "fresh",
        "fresh",
      ]);
    },
  );

  it("re-reads the local window after a native provider sync and returns that snapshot", async () => {
    const { aggregate, reads, broker } = fixture();
    const feed = await aggregate([eliza, native]);
    expect(reads).toEqual(["eliza", "google", "eliza"]);
    expect(broker).toEqual([]);
    expect(titles(feed)).toEqual(["eliza-2", "google-1"]);
  });

  it("still re-reads when a native provider sits beside a managed feed", async () => {
    const { aggregate, reads, broker } = fixture();
    const feed = await aggregate([eliza, managed, native]);
    expect(reads).toEqual(["eliza", "google", "eliza"]);
    expect(broker).toEqual(["feed"]);
    expect(titles(feed)).toEqual(["eliza-2", "google-1", "managed"]);
  });

  it("still re-reads when an ICS subscription is selected", async () => {
    const { aggregate, reads } = fixture();
    const feed = await aggregate([eliza, ics]);
    expect(reads).toEqual(["eliza", "eliza"]);
    expect(titles(feed)).toEqual(["eliza-2"]);
  });

  it("reads the local window once when it is the only calendar", async () => {
    const { aggregate, reads } = fixture();
    const feed = await aggregate([eliza]);
    expect(reads).toEqual(["eliza"]);
    expect(titles(feed)).toEqual(["eliza-1"]);
  });
});
