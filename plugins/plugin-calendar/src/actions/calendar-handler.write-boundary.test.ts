/** Exercises the actual conversational create boundary, before service writes. */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { createCalendarActionRunner } from "./calendar-handler.js";
import { evaluateCalendarWriteAvailability } from "./conflict-detect.js";
import type { CalendarActionDeps } from "./deps.js";

const start = "2027-09-18T20:00:00.000Z";
const end = "2027-09-18T20:30:00.000Z";
const key = {
  provider: "eliza",
  side: "owner",
  grantId: "eliza-calendar",
  connectorAccountId: "eliza-calendar",
  calendarId: "primary",
};
const busy = {
  ...key,
  id: "busy",
  externalId: "busy",
  agentId: "agent",
  title: "Existing appointment",
  startAt: start,
  endAt: end,
  timezone: "America/New_York",
  isAllDay: false,
  attendees: [],
  metadata: {},
  status: "confirmed",
  description: "",
  location: "",
} as LifeOpsCalendarEvent;
function fixture(events: LifeOpsCalendarEvent[] = [], status = "fresh") {
  const service = {
    getCalendarFeed: vi.fn(async () => ({
      events,
      state: status === "fresh" ? "complete" : "partial",
      source: "synced",
      syncedAt: new Date().toISOString(),
      sources: [{ key, status, visibility: "details", error: null }],
    })),
    prepareCalendarEventCreate: vi.fn(async (_url, request) => ({
      ...request,
      startAt: request.startAt,
      endAt: request.endAt ?? end,
      timeZone: "America/New_York",
      grantId: "eliza-calendar",
      calendarId: "primary",
      side: "owner",
    })),
    createCalendarEvent: vi.fn(async (_url, request) => ({
      ...busy,
      ...request,
      description: request.description ?? "",
      location: request.location ?? "",
      id: "created",
      externalId: "created",
      metadata: { version: 1, etag: '"1"' },
    })),
  };
  const runtime = {
    agentId: "00000000-0000-4000-8000-000000000aaa",
    getService: (name: string) => (name === "calendar" ? service : null),
    getSetting: () => undefined,
    character: { name: "Eliza" },
  } as unknown as IAgentRuntime;
  return { service, runtime };
}
async function create(
  extracted: Record<string, unknown>,
  events: LifeOpsCalendarEvent[] = [],
) {
  const { runtime, service } = fixture(events);
  const runJsonModel = vi.fn(async () => ({
    rawResponse: JSON.stringify(extracted),
    parsed: extracted,
  }));
  const action = createCalendarActionRunner({
    runJsonModel: runJsonModel as CalendarActionDeps["runJsonModel"],
    runTextModel: async () => null,
    recentConversationTexts: async () => [],
  });
  const message = {
    id: "00000000-0000-4000-8000-000000000aab",
    entityId: "00000000-0000-4000-8000-000000000aac",
    roomId: "00000000-0000-4000-8000-000000000aad",
    createdAt: Date.now(),
    content: {
      text: "make a calendar reminder to call dad",
      metadata: { uiTimeZone: "America/New_York" },
    },
  } as Memory;
  const result = await action.handler(runtime, message, undefined, {
    parameters: {
      subaction: "create_event",
      title: "Call dad",
      details: { start, end },
    },
  });
  return { result, service, runJsonModel };
}

describe("calendar conversational write boundary", () => {
  it("asks for missing timing despite complete fabricated native arguments", async () => {
    const { result, service, runJsonModel } = await create({
      title: "Call dad",
    });
    expect(runJsonModel).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: false,
      data: { requiresInput: true, missing: ["startAt"] },
    });
    expect(service.prepareCalendarEventCreate).not.toHaveBeenCalled();
    expect(service.createCalendarEvent).not.toHaveBeenCalled();
  });
  it("blocks a grounded proposed time that overlaps an existing event", async () => {
    const { result, service } = await create(
      { title: "Call dad", startAt: start, endAt: end },
      [busy],
    );
    expect(result).toMatchObject({
      success: false,
      data: {
        requiresInput: true,
        availability: {
          definitive: true,
          conflicts: [{ eventB: { id: "busy" } }],
        },
      },
    });
    expect(service.createCalendarEvent).not.toHaveBeenCalled();
  });
  it("writes a grounded free time after checking the exact proposal range", async () => {
    const { result, service } = await create({
      title: "Call dad",
      startAt: start,
      endAt: end,
    });
    expect(result).toMatchObject({ success: true });
    expect(service.createCalendarEvent).toHaveBeenCalledOnce();
    expect(service.getCalendarFeed).toHaveBeenLastCalledWith(expect.any(URL), {
      side: "owner",
      timeMin: start,
      timeMax: end,
    });
  });
  it("excludes only the moved event and never calls stale coverage free", async () => {
    const { runtime } = fixture([busy]);
    const result = await evaluateCalendarWriteAvailability({
      runtime,
      startAt: start,
      endAt: end,
      timeZone: "America/New_York",
      excludeEventId: "busy",
    });
    expect(result.definitive).toBe(true);
    expect(result.conflicts).toEqual([]);
    const stale = fixture([], "stale");
    expect(
      (
        await evaluateCalendarWriteAvailability({
          runtime: stale.runtime,
          startAt: start,
          endAt: end,
          timeZone: "America/New_York",
        })
      ).definitive,
    ).toBe(false);
  });
});
