/** Exercises the actual conversational create boundary, before service writes. */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { createCalendarActionRunner } from "./calendar-handler.js";
import {
  evaluateCalendarWriteAvailability,
  findCalendarFreeSlots,
} from "./conflict-detect.js";
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
          alternatives: [
            {
              start: "2027-09-18T20:30:00.000Z",
              end: "2027-09-18T21:00:00.000Z",
            },
            {
              start: "2027-09-18T21:00:00.000Z",
              end: "2027-09-18T21:30:00.000Z",
            },
          ],
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
    const { runtime, service } = fixture([busy]);
    const result = await evaluateCalendarWriteAvailability({
      runtime,
      startAt: start,
      endAt: end,
      timeZone: "America/New_York",
      excludeEventId: "busy",
    });
    expect(result.definitive).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(service.getCalendarFeed).toHaveBeenCalledOnce();
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

describe("calendar conversational update boundary", () => {
  async function update(
    extracted: Record<string, unknown>,
    identifyTarget = true,
    plannerFields: Record<string, unknown> = {},
    targetSelector?: { query?: string; eventId?: string },
  ) {
    const { service, runtime } = fixture(
      targetSelector?.query ? [{ ...busy, metadata: { etag: '"1"' } }] : [],
    );
    const target = { ...busy, metadata: { etag: '"1"' } };
    const updateCalendarEvent = vi.fn(async (_url, request) => ({
      ...target,
      ...request,
      metadata: { etag: '"2"' },
    }));
    Object.assign(service, {
      getConditionalCalendarMutationTarget: vi.fn(async () => target),
      updateCalendarEvent,
    });
    const action = createCalendarActionRunner({
      runJsonModel: (async () => ({
        rawResponse: JSON.stringify(extracted),
        parsed: extracted,
      })) as CalendarActionDeps["runJsonModel"],
      runTextModel: async () => null,
      recentConversationTexts: async () => [],
    });
    const result = await action.handler(
      runtime,
      {
        id: "00000000-0000-4000-8000-000000000aab",
        entityId: "00000000-0000-4000-8000-000000000aac",
        roomId: "00000000-0000-4000-8000-000000000aad",
        createdAt: Date.now(),
        content: {
          text: identifyTarget
            ? "Move that appointment to 5 PM, keeping its duration."
            : "Use the first one, 9:00 AM.",
          metadata: { uiTimeZone: "America/New_York" },
        },
      } as Memory,
      undefined,
      {
        parameters: {
          subaction: "update_event",
          ...(targetSelector
            ? {
                targetKind: targetSelector.eventId ? "eventId" : "query",
                target: targetSelector.eventId ?? targetSelector.query,
              }
            : {}),
          details: {
            ...(identifyTarget ? { eventId: "busy" } : {}),
            start: "2027-09-18T14:00:00",
            end: "2027-09-18T16:00:00",
            notifyAttendees: true,
            ...plannerFields,
          },
        },
      },
    );
    return { result, service, updateCalendarEvent };
  }
  it.each([{ eventId: "busy" }, { query: "Existing appointment" }])(
    "resolves a promoted typed target %j",
    async (target) => {
      const { result, updateCalendarEvent } = await update(
        { startAt: "2027-09-18T17:00:00" },
        false,
        {},
        target,
      );
      expect(result.success).toBe(true);
      expect(updateCalendarEvent).toHaveBeenCalledOnce();
      expect(updateCalendarEvent.mock.calls[0][1].eventId).toBe("busy");
    },
  );
  it("marks only the missing-target preflight as coaching without reading or writing", async () => {
    const { result, service, updateCalendarEvent } = await update({}, false);
    expect(result).toMatchObject({
      success: false,
      data: { error: "CALENDAR_TARGET_UNRESOLVED", coachingFailure: true },
      effectReceipts: [{ outcome: "noop" }],
    });
    expect(service.getCalendarFeed).not.toHaveBeenCalled();
    expect(service.getConditionalCalendarMutationTarget).not.toHaveBeenCalled();
    expect(updateCalendarEvent).not.toHaveBeenCalled();
  });
  it("uses the extracted local range instead of mixing it with planner timing", async () => {
    const { service, updateCalendarEvent } = await update({
      startAt: "2027-09-18T17:00:00",
    });
    expect(updateCalendarEvent).toHaveBeenCalledOnce();
    expect(updateCalendarEvent.mock.calls[0][1]).toMatchObject({
      startAt: "2027-09-18T17:00:00",
      endAt: "2027-09-18T17:30:00",
      title: undefined,
      description: undefined,
      notifyAttendees: false,
    });
    expect(service.getCalendarFeed).toHaveBeenLastCalledWith(expect.any(URL), {
      side: "owner",
      timeMin: "2027-09-18T21:00:00.000Z",
      timeMax: "2027-09-18T21:30:00.000Z",
    });
  });
  it("does not save planner-authored unrelated fields during a time change", async () => {
    const { updateCalendarEvent } = await update(
      { startAt: "2027-09-18T17:00:00" },
      true,
      {
        newTitle: "Invented",
        description: "Invented",
        location: "primary",
        clearFields: ["location"],
      },
    );
    expect(updateCalendarEvent).toHaveBeenCalledOnce();
    expect(updateCalendarEvent.mock.calls[0][1]).toMatchObject({
      title: undefined,
      description: undefined,
      location: undefined,
    });
  });
  it("preserves extracted replacements and explicit clearing", async () => {
    const { updateCalendarEvent } = await update({
      title: "Requested title",
      description: "Requested description",
      clearFields: ["location"],
    });
    expect(updateCalendarEvent).toHaveBeenCalledOnce();
    expect(updateCalendarEvent.mock.calls[0][1]).toMatchObject({
      title: "Requested title",
      description: "Requested description",
      location: "",
    });
  });
  it.each([{ requiresInput: true, clarification: "What exact time?" }])(
    "pauses an unresolved update without borrowing planner timestamps",
    async (extracted) => {
      const { result, updateCalendarEvent } = await update(extracted);
      expect(result).toMatchObject({
        success: false,
        data: { requiresInput: true },
      });
      expect(result.data?.coachingFailure).not.toBe(true);
      expect(updateCalendarEvent).not.toHaveBeenCalled();
    },
  );
});

describe("verified alternative slots", () => {
  const range = { start: "2027-09-18T20:00:00Z", end: "2027-09-18T22:00:00Z" };
  const source = {
    id: "owner",
    status: "fresh" as const,
    visibility: "details" as const,
    events: [
      {
        id: "busy",
        title: "Busy",
        startISO: "2027-09-18T20:00:00Z",
        endISO: "2027-09-18T20:30:00Z",
      },
    ],
  };
  it("fits the full duration after blockers without overlapping its own suggestions", () => {
    expect(
      findCalendarFreeSlots({
        range,
        timeZone: "America/New_York",
        sources: [source],
        durationMs: 45 * 60_000,
      }),
    ).toEqual([
      { start: "2027-09-18T20:30:00.000Z", end: "2027-09-18T21:15:00.000Z" },
      { start: "2027-09-18T21:15:00.000Z", end: "2027-09-18T22:00:00.000Z" },
    ]);
  });
  it("does not offer free times from stale or unavailable coverage", () => {
    for (const status of ["stale", "error", "disconnected"] as const) {
      expect(
        findCalendarFreeSlots({
          range,
          timeZone: "UTC",
          sources: [{ ...source, status }],
          durationMs: 15 * 60_000,
        }),
      ).toEqual([]);
    }
  });
  it("does not squeeze an event beyond the window", () => {
    expect(
      findCalendarFreeSlots({
        range,
        timeZone: "UTC",
        sources: [source],
        durationMs: 100 * 60_000,
      }),
    ).toEqual([]);
  });
});
