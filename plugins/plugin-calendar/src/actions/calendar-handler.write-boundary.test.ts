/** Exercises the actual conversational create boundary, before service writes. */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/core/contracts/calendar";
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
function fixture(
  events: LifeOpsCalendarEvent[] = [],
  status = "fresh",
  sourceKey = key,
) {
  const service = {
    getCalendarFeed: vi.fn(
      async (_url: string, _options: Record<string, unknown>) => ({
        events,
        state: status === "fresh" ? "complete" : "partial",
        source: "synced",
        syncedAt: new Date().toISOString(),
        sources: [
          { key: sourceKey, status, visibility: "details", error: null },
        ],
      }),
    ),
    prepareCalendarEventCreate: vi.fn(async (_url, request) => ({
      ...request,
      startAt: request.startAt,
      endAt: request.endAt ?? end,
      timeZone: "America/New_York",
      grantId: request.grantId ?? "eliza-calendar",
      calendarId: request.calendarId ?? "primary",
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
  const reportError = vi.fn();
  const runtime = {
    reportError,
    agentId: "00000000-0000-4000-8000-000000000aaa",
    getService: (name: string) => (name === "calendar" ? service : null),
    getSetting: () => undefined,
    character: { name: "Eliza" },
  } as unknown as IAgentRuntime;
  return { service, runtime, reportError };
}
async function create(
  extracted: Record<string, unknown>,
  events: LifeOpsCalendarEvent[] = [],
  request?: {
    text: string;
    createdAt: number;
    details?: Record<string, unknown>;
  },
  sourceKey = key,
) {
  const { runtime, service, reportError } = fixture(events, "fresh", sourceKey);
  const parsed = {
    grantId: key.grantId,
    calendarId: key.calendarId,
    ...extracted,
  };
  const runJsonModel = vi.fn(async () => ({
    rawResponse: JSON.stringify(parsed),
    parsed,
  }));
  const schedule = vi.fn(async () => ({
    requestId: "calendar-approval",
    action: "schedule_event" as const,
    state: "pending" as const,
    acceptedAt: "2027-09-17T12:00:00.000Z",
    idempotencyKey: "calendar-approval:test",
    replayed: false,
    text: "Approval required",
  }));
  const action = createCalendarActionRunner({
    mutationGateway: { schedule, modify: vi.fn(), cancel: vi.fn() },
    runJsonModel: runJsonModel as CalendarActionDeps["runJsonModel"],
    runTextModel: async () => null,
    recentConversationTexts: async () => [],
  });
  const message = {
    id: "00000000-0000-4000-8000-000000000aab",
    entityId: "00000000-0000-4000-8000-000000000aac",
    roomId: "00000000-0000-4000-8000-000000000aad",
    createdAt: request?.createdAt ?? Date.now(),
    content: {
      text: request?.text ?? "make a calendar reminder to call dad",
      metadata: { uiTimeZone: "America/New_York" },
    },
  } as Memory;
  const result = await action.handler(runtime, message, undefined, {
    parameters: {
      subaction: "create_event",
      title: "Call dad",
      details: { start, end, ...request?.details },
    },
  });
  return { result, service, runJsonModel, schedule, reportError };
}

describe("calendar conversational write boundary", () => {
  it("does not hide calendar sources behind a planner-proposed destination", async () => {
    const { service, result } = await create(
      { requiresInput: true, grantId: null, calendarId: null },
      [],
      {
        text: "Create an event on Google Calendar tomorrow at 3pm.",
        createdAt: Date.parse("2027-09-17T12:00:00Z"),
        details: {
          grantId: "connector-account:guessed",
          calendarId: "guessed",
          mode: "remote",
          side: "agent",
        },
      },
    );
    const options = service.getCalendarFeed.mock.calls[0]?.[1];
    expect(options).toBeDefined();
    expect(options).not.toHaveProperty("grantId");
    expect(options).not.toHaveProperty("calendarId");
    expect(options).not.toHaveProperty("mode");
    expect(options).not.toHaveProperty("side");
    expect(result).toMatchObject({
      success: false,
      data: { requiresInput: true },
    });
    expect(service.prepareCalendarEventCreate).not.toHaveBeenCalled();
    expect(service.createCalendarEvent).not.toHaveBeenCalled();
  });

  it("prepares the extracted connected account when planner arguments omit its grant", async () => {
    const sourceKey = {
      ...key,
      provider: "google",
      grantId: "connector-account:work",
      connectorAccountId: "work",
    };
    const { result, service, schedule, reportError } = await create(
      {
        title: "Call dad",
        startAt: start,
        endAt: end,
        grantId: sourceKey.grantId,
        calendarId: sourceKey.calendarId,
      },
      [],
      {
        text: "Use my work Google account, primary calendar, on September 18, 2027 at the requested time.",
        createdAt: Date.parse("2027-09-17T12:00:00Z"),
      },
      sourceKey,
    );
    expect(service.prepareCalendarEventCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        grantId: sourceKey.grantId,
        calendarId: "primary",
        side: "owner",
      }),
    );
    expect(service.createCalendarEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      data: { approvalRequired: true },
    });
    expect(schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          grantId: sourceKey.grantId,
          calendarId: "primary",
        }),
      }),
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each([
    { grantId: null, calendarId: null },
    { grantId: "unavailable-account", calendarId: "primary" },
    { grantId: "eliza-calendar", calendarId: "unknown-calendar" },
  ])(
    "does not write when extracted destination is unresolved: %j",
    async (destination) => {
      const { result, service } = await create({
        title: "Call dad",
        startAt: start,
        endAt: end,
        requiresInput: false,
        ...destination,
      });
      expect(result).toMatchObject({
        success: false,
        data: { requiresInput: true },
      });
      expect(service.prepareCalendarEventCreate).not.toHaveBeenCalled();
      expect(service.createCalendarEvent).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["2027-03-14T02:30:00", "CALENDAR_LOCAL_TIME_NONEXISTENT"],
    ["2027-11-07T01:30:00", "CALENDAR_LOCAL_TIME_AMBIGUOUS"],
  ])(
    "requests clarification before preparing a write at %s",
    async (startAt, code) => {
      const { result, service } = await create(
        {
          title: "Call dad",
          startAt,
          timeZone: "America/New_York",
          durationMinutes: 30,
        },
        [],
        {
          text: "Schedule Call dad at the requested local time in New York.",
          createdAt: Date.parse("2027-03-01T12:00:00Z"),
        },
      );
      expect(result).toMatchObject({
        success: false,
        effectReceipts: [
          {
            outcome: "failed",
            failure: { code, retryable: false, acceptance: "rejected" },
          },
        ],
        data: {
          error: code,
          requiresInput: true,
          awaitingUserInput: true,
          retryable: false,
          timeClarification: { timeZone: "America/New_York" },
        },
      });
      expect(service.prepareCalendarEventCreate).not.toHaveBeenCalled();
      expect(service.createCalendarEvent).not.toHaveBeenCalled();
    },
  );

  it("keeps the extracted schedule when an event title contains another date", async () => {
    const { result, service } = await create(
      { title: "September 22 QA", startAt: start, endAt: end },
      [],
      {
        text: 'Create an event called "September 22 QA" tomorrow at 4 PM for 30 minutes.',
        createdAt: Date.parse("2027-09-17T16:00:00Z"),
      },
    );
    expect(result).toMatchObject({ success: true });
    expect(service.createCalendarEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ startAt: start, endAt: end }),
    );
    expect(service.getCalendarFeed).toHaveBeenLastCalledWith(expect.any(URL), {
      side: "owner",
      timeMin: start,
      timeMax: end,
    });
  });
  it("still pauses when the extracted start has already passed", async () => {
    const { result, service } = await create(
      { title: "Call dad", startAt: start, endAt: end },
      [],
      {
        text: "Call dad at 4 PM for 30 minutes.",
        createdAt: Date.parse("2027-09-18T22:00:00Z"),
      },
    );
    expect(result).toMatchObject({
      success: false,
      data: { requiresInput: true, missing: ["confirmed date"] },
    });
    expect(service.createCalendarEvent).not.toHaveBeenCalled();
  });
  it("asks for missing timing despite complete fabricated native arguments", async () => {
    const { result, service, runJsonModel } = await create({
      title: "Call dad",
    });
    expect(runJsonModel).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ temperature: 0 }),
    );
    expect(result).toMatchObject({
      success: false,
      data: {
        requiresInput: true,
        awaitingUserInput: true,
        missing: ["startAt"],
      },
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
        awaitingUserInput: true,
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
  it.each([
    ["2027-09-18", "4:00 PM EDT", "4:30 PM EDT"],
    ["2027-01-18", "3:00 PM EST", "3:30 PM EST"],
  ])(
    "grounds conflict reply times in the requested zone on %s",
    async (day, localStart, localEnd) => {
      const startAt = `${day}T20:00:00.000Z`;
      const endAt = `${day}T20:30:00.000Z`;
      const { runtime } = fixture([{ ...busy, startAt, endAt }]);
      const result = await evaluateCalendarWriteAvailability({
        runtime,
        startAt,
        endAt,
        timeZone: "America/New_York",
      });
      expect(result.localTimes.timeZone).toBe("America/New_York");
      expect(result.localTimes.conflicts).toEqual([
        {
          title: busy.title,
          start: expect.stringContaining(localStart),
          end: expect.stringContaining(localEnd),
        },
      ]);
      expect(result.conflicts[0]?.eventB.startISO).toBe(startAt);
      expect(result.conflicts[0]?.eventB.endISO).toBe(endAt);
      expect(result.localTimes.alternatives[0]?.start).toContain(localEnd);
      expect(result.alternatives?.[0]?.start).toBe(endAt);
    },
  );
});

describe("calendar conversational update boundary", () => {
  async function update(
    extracted: Record<string, unknown>,
    identifyTarget = true,
    plannerFields: Record<string, unknown> = {},
    targetSelector?: { query?: string; eventId?: string },
    request?: {
      text: string;
      createdAt: number;
      details?: Record<string, unknown>;
    },
  ) {
    const { service, runtime } = fixture(
      targetSelector?.query ? [{ ...busy, metadata: { etag: '"1"' } }] : [],
    );
    const target = { ...busy, metadata: { etag: '"1"' } };
    const updateCalendarEvent = vi.fn(async (_url, request) => ({
      ...target,
      ...request,
      // Match the service PATCH contract: omitted fields retain stored values.
      startAt: request.startAt ?? target.startAt,
      endAt: request.endAt ?? target.endAt,
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
        createdAt: request?.createdAt ?? Date.now(),
        content: {
          text:
            request?.text ??
            (identifyTarget
              ? "Move that appointment to 5 PM, keeping its duration."
              : "Use the first one, 9:00 AM."),
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
  it("does not rewrite a resolved future Saturday to an already-passed Saturday", async () => {
    const { result, service, updateCalendarEvent } = await update(
      { startAt: "2027-09-25T17:00:00" },
      true,
      {},
      undefined,
      {
        text: "Move that appointment to Saturday at 5 PM.",
        createdAt: Date.parse("2027-09-19T02:15:00Z"),
      },
    );
    expect(result.success).toBe(true);
    expect(updateCalendarEvent).toHaveBeenCalledOnce();
    expect(updateCalendarEvent.mock.calls[0][1]).toMatchObject({
      startAt: "2027-09-25T17:00:00",
      endAt: "2027-09-25T17:30:00",
    });
    expect(service.getCalendarFeed).toHaveBeenLastCalledWith(expect.any(URL), {
      side: "owner",
      timeMin: "2027-09-25T21:00:00.000Z",
      timeMax: "2027-09-25T21:30:00.000Z",
    });
  });
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
  it.each([{}, { requiresInput: false, startAt: null, endAt: null }])(
    "does not revive planner timing after empty extraction: %j",
    async (extracted) => {
      const { result, updateCalendarEvent } = await update(extracted);
      expect(result).toMatchObject({
        success: false,
        data: { requiresInput: true },
      });
      expect(updateCalendarEvent).not.toHaveBeenCalled();
    },
  );
  it("does not attach planner timing or timezone to an extracted rename", async () => {
    const { updateCalendarEvent } = await update(
      { title: "Renamed appointment" },
      true,
      { timeZone: "UTC" },
    );
    expect(updateCalendarEvent).toHaveBeenCalledOnce();
    expect(updateCalendarEvent.mock.calls[0][1]).toMatchObject({
      title: "Renamed appointment",
      startAt: undefined,
      endAt: undefined,
      timeZone: "America/New_York",
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
