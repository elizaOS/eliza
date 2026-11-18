import {
  type Action,
  type ActionResult,
  type IAgentRuntime,
  type Memory,
  normalizeEffectReceipt,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  asksOnlyAboutTomorrowMorning,
  calendarAvailabilityActions,
} from "./calendar-availability.js";

const timeZone = "America/Los_Angeles";
const start = "2026-11-06T17:00:00.000Z";
const end = "2026-11-06T18:30:00.000Z";
const firstEnd = "2026-11-06T17:30:00.000Z";
const secondStart = "2026-11-06T18:00:00.000Z";
const observedAt = "2026-11-06T00:51:02.317Z";
const agentId = stringToUuid("calendar-availability-owner");
const runtime = { agentId } as IAgentRuntime;
const message = {
  id: stringToUuid("calendar-availability-request"),
  roomId: stringToUuid("calendar-availability-room"),
  entityId: agentId,
  agentId,
  createdAt: Date.parse(observedAt),
  content: {
    text: "When am I free for half an hour between 9 and 10:30 tomorrow morning?",
  },
} satisfies Memory;

function fixture(source: "runtime" | "device" = "runtime") {
  const key = {
    provider: "eliza_calendar",
    side: "owner",
    calendarId: "primary",
  };
  const busy = (id: string, startAt: string, endAt: string) => ({
    ...key,
    id,
    title: id,
    startAt,
    endAt,
    status: "confirmed",
    isAllDay: false,
    timezone: timeZone,
    metadata: {},
    attendees: [],
  });
  const feed = {
    success: true,
    data: {
      state: "complete",
      timeMin: start,
      timeMax: end,
      sources: [{ key, status: "fresh", visibility: "details" }],
      events: [
        busy("first", start, firstEnd),
        busy("second", secondStart, end),
      ],
      requestWindow: {
        kind: "calendar.request-window.v1",
        sourceMessageId: message.id,
        roomId: message.roomId,
        actorId: message.entityId,
        requestedAt: message.createdAt,
        timeZone,
        timeMin: start,
        timeMax: end,
      },
    },
    effectReceipts: [
      normalizeEffectReceipt({
        receiptId: stringToUuid("calendar-feed-receipt"),
        operation: "calendar.feed.read",
        resource: { kind: "calendar.feed", id: "local", version: "snapshot-1" },
        observedAt,
        idempotency: { key: null, replayed: false },
        artifacts: [],
        outcome: "noop",
        reason: "Read the authoritative test snapshot.",
      }),
    ],
  } satisfies ActionResult;
  const handler = vi.fn(async () => feed);
  const actions = calendarAvailabilityActions(
    { name: "CALENDAR", similes: [], description: "Read Calendar", handler },
    () => source,
  );
  const call = (
    name: string,
    extra: Record<string, unknown> = {},
    text?: string,
  ) =>
    actions
      .find((action: Action) => action.name === name)
      ?.handler?.(
        runtime,
        text === undefined ? message : { ...message, content: { text } },
        undefined,
        {
          parameters: {
            windowStart: start,
            windowEnd: end,
            timeZone,
            ...extra,
          },
        },
      );
  return { feed, handler, call };
}

describe("standalone Calendar availability", () => {
  it("proposes only the 9:30–10:00 Pacific gap from the exact bounded owner feed", async () => {
    const { call, feed, handler } = fixture();
    const result = await call("CALENDAR_PROPOSE_TIMES", {
      durationMinutes: 30,
    });
    expect(handler).toHaveBeenCalledExactlyOnceWith(
      runtime,
      message,
      undefined,
      {
        parameters: {
          subaction: "feed",
          details: { timeMin: start, timeMax: end, timeZone },
        },
      },
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        slots: [
          {
            startAt: firstEnd,
            endAt: secondStart,
            durationMinutes: 30,
            timeZone,
          },
        ],
      },
      effectReceipts: [
        {
          outcome: "preview",
          operation: "calendar.propose_times.preview",
          observedAt,
          resource: feed.effectReceipts[0].resource,
        },
      ],
    });
  });

  it("uses the same snapshot to reject a claim that the full interval is free", async () => {
    const { call } = fixture();
    expect(await call("CALENDAR_CHECK_AVAILABILITY")).toMatchObject({
      success: true,
      data: {
        isFree: false,
        conflicts: [
          { startAt: start, endAt: firstEnd },
          { startAt: secondStart, endAt: end },
        ],
      },
      effectReceipts: [
        { outcome: "noop", operation: "calendar.check_availability.read" },
      ],
    });
  });

  it("rejects an evening end for a morning-only request before reading Calendar", async () => {
    const { call, handler } = fixture();
    expect(
      await call("CALENDAR_CHECK_AVAILABILITY", {
        windowStart: "2026-11-06T16:00:00.000Z",
        windowEnd: "2026-11-07T04:00:00.000Z",
      }),
    ).toMatchObject({
      success: false,
      data: {
        definitive: false,
        code: "CALENDAR_AVAILABILITY_OUTSIDE_REQUESTED_PERIOD",
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    "Am I free tomorrow morning?",
    "Do I have 20 minutes tomorrow morning",
    "Find me time for a call tomorrow morning.",
    "Am I free tomorrow morning until noon?",
    "Am I free tomorrow morning through 12:00 PM?",
  ])("rejects an over-long window for %j", async (text) => {
    const { call, handler } = fixture();
    expect(
      await call(
        "CALENDAR_CHECK_AVAILABILITY",
        { windowEnd: "2026-11-07T04:00:00.000Z" },
        text,
      ),
    ).toMatchObject({
      success: false,
      data: { code: "CALENDAR_AVAILABILITY_OUTSIDE_REQUESTED_PERIOD" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a morning window that starts before tomorrow", async () => {
    const { call, handler } = fixture();
    expect(
      await call("CALENDAR_CHECK_AVAILABILITY", {
        // 23:00 Pacific on the day of the request.
        windowStart: "2026-11-06T07:00:00.000Z",
      }),
    ).toMatchObject({
      success: false,
      data: { code: "CALENDAR_AVAILABILITY_OUTSIDE_REQUESTED_PERIOD" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("accepts a morning window from tomorrow's midnight through noon", async () => {
    const { call, handler, feed } = fixture();
    const midnight = "2026-11-06T08:00:00.000Z";
    const noon = "2026-11-06T20:00:00.000Z";
    feed.data.timeMin = midnight;
    feed.data.timeMax = noon;
    feed.data.requestWindow.timeMin = midnight;
    feed.data.requestWindow.timeMax = noon;
    expect(
      await call("CALENDAR_CHECK_AVAILABILITY", {
        windowStart: midnight,
        windowEnd: noon,
      }),
    ).toMatchObject({ success: true, data: { isFree: false } });
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([
    "Am I free tomorrow morning or afternoon?",
    "Check today or tomorrow morning.",
    "Do I have time after tomorrow morning?",
    "Is Friday or tomorrow morning free?",
  ])("reads the window for a wider request: %s", async (text) => {
    const { call, handler, feed } = fixture();
    const wideEnd = "2026-11-07T04:00:00.000Z";
    feed.data.timeMax = wideEnd;
    feed.data.requestWindow.timeMax = wideEnd;
    expect(
      await call("CALENDAR_CHECK_AVAILABILITY", { windowEnd: wideEnd }, text),
    ).toMatchObject({ success: true, data: { isFree: false } });
    expect(handler).toHaveBeenCalledExactlyOnceWith(
      runtime,
      { ...message, content: { text } },
      undefined,
      {
        parameters: {
          subaction: "feed",
          details: { timeMin: start, timeMax: wideEnd, timeZone },
        },
      },
    );
  });

  it("recognises only a tomorrow-morning-only request", () => {
    expect(asksOnlyAboutTomorrowMorning("am i free tomorrow morning")).toBe(
      true,
    );
    expect(
      asksOnlyAboutTomorrowMorning("Am I free tomorrow morning until 2 pm?"),
    ).toBe(false);
    expect(asksOnlyAboutTomorrowMorning("Am I free tomorrow evening?")).toBe(
      false,
    );
    expect(asksOnlyAboutTomorrowMorning("Am I free this morning?")).toBe(false);
  });

  it("does not substitute the runtime calendar for a selected device source", async () => {
    const { call, handler } = fixture("device");
    expect(
      await call("CALENDAR_PROPOSE_TIMES", { durationMinutes: 30 }),
    ).toMatchObject({
      success: false,
      data: { definitive: false, code: "CALENDAR_SOURCE_UNAVAILABLE" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not infer a free slot when one source is stale", async () => {
    const { call, feed } = fixture();
    feed.data.sources[0].status = "stale";
    expect(
      await call("CALENDAR_PROPOSE_TIMES", { durationMinutes: 30 }),
    ).toMatchObject({
      success: false,
      data: { definitive: false, code: "CALENDAR_AVAILABILITY_INCOMPLETE" },
    });
  });

  it("rejects an otherwise complete feed belonging to a different owner request", async () => {
    const { call, feed } = fixture();
    feed.data.requestWindow.sourceMessageId = stringToUuid("another request");
    expect(
      await call("CALENDAR_PROPOSE_TIMES", { durationMinutes: 30 }),
    ).toMatchObject({
      success: false,
      data: { definitive: false, code: "CALENDAR_AVAILABILITY_INCOMPLETE" },
    });
  });
});
