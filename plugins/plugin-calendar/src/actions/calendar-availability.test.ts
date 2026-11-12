import {
  type Action,
  type ActionResult,
  type IAgentRuntime,
  type Memory,
  normalizeEffectReceipt,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { calendarAvailabilityActions } from "./calendar-availability.js";

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
  const call = (name: string, extra: Record<string, unknown> = {}) =>
    actions
      .find((action: Action) => action.name === name)
      ?.handler?.(runtime, message, undefined, {
        parameters: { windowStart: start, windowEnd: end, timeZone, ...extra },
      });
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
