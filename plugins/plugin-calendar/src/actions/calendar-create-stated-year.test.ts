/**
 * Stated-year correction through the real create handler.
 *
 * Conditional repro: the extraction (planner details + model extraction)
 * already names the right day, 2027-01-05. The post-processing must not
 * overwrite it with the parser's year. On base the stated-date correction
 * parses "2027년 1월 5일" as 2026-01-05 and the past-start guard blocks the
 * create; with the fix the request reaches the creation boundary.
 */
import { AgentRuntime, type Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { CalendarService } from "../service/CalendarService.ts";
import { createCalendarActionRunner } from "./calendar-handler.ts";

// Fixed "now": Saturday 2026-11-14 12:00 in Seoul (03:00Z). January 5 this
// year has already passed, January 5 next year has not.
const NOW_MS = Date.parse("2026-11-14T03:00:00.000Z");
const ZONE = "Asia/Seoul";
const TEXT = "2027년 1월 5일 오후 3시에 회의 잡아줘";
const MESSAGE_ID = "00000000-0000-0000-0000-000000000001";

function extraction(text: string, startAt: string, endAt: string) {
  // Authority validation requires "none" evidence to cite the complete
  // current request against the `current:<messageId>` source id.
  const evidence = [{ sourceId: `current:${MESSAGE_ID}`, quote: text }];
  return {
    requiresInput: false,
    clarification: null,
    grantId: "eliza-calendar",
    calendarId: "primary",
    title: "회의",
    description: null,
    location: null,
    startAt,
    endAt,
    timeZone: ZONE,
    recurrence: null,
    travelOriginAddress: null,
    durationMinutes: 60,
    isShortPreparation: false,
    guestIntent: {
      state: "none",
      guests: [],
      evidence,
    },
    noteIntent: {
      state: "none",
      descriptionMode: "extracted",
      sourceNote: null,
      evidence,
    },
  };
}

async function runCreate(text: string, startAt: string, endAt: string) {
  const runtime = new AgentRuntime({
    character: { name: "Calendar stated year", bio: [] },
  });
  const service = new CalendarService(runtime);
  runtime.services.set(CalendarService.serviceType, [service]);
  const feed = {
    calendarId: "primary",
    events: [],
    source: "synced" as const,
    state: "complete" as const,
    sources: [
      {
        key: { grantId: "eliza-calendar", calendarId: "primary" },
        status: "fresh" as const,
      },
    ],
    timeMin: "2026-11-14T00:00:00.000Z",
    timeMax: "2026-11-28T00:00:00.000Z",
    syncedAt: "2026-11-14T03:00:00.000Z",
  };
  vi.spyOn(service, "getCalendarFeed").mockResolvedValue(feed as never);
  vi.spyOn(service, "listCalendars").mockResolvedValue([
    { id: "primary", summary: "Primary" },
  ] as never);
  const created = {
    id: "evt-created",
    externalId: "evt-created",
    agentId: runtime.agentId,
    provider: "eliza" as const,
    side: "owner" as const,
    grantId: "eliza-calendar",
    calendarId: "primary",
    title: "회의",
    description: "",
    location: "",
    status: "confirmed",
    startAt: "2027-01-05T06:00:00.000Z",
    endAt: "2027-01-05T07:00:00.000Z",
    timezone: ZONE,
    isAllDay: false,
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
  };
  const create = vi
    .spyOn(service, "createCalendarEvent")
    .mockResolvedValue(created as never);
  const runJsonModel = vi.fn(async () => ({
    parsed: extraction(text, startAt, endAt),
  }));
  const runTextModel = vi.fn(async () => {
    throw Error("Stated-year create must not call a text model");
  });
  const action = createCalendarActionRunner({
    runTextModel,
    runJsonModel,
    recentConversationTexts: async () => [],
  });
  const message = {
    id: MESSAGE_ID,
    entityId: "00000000-0000-0000-0000-000000000002",
    roomId: "00000000-0000-0000-0000-000000000003",
    agentId: runtime.agentId,
    createdAt: NOW_MS,
    content: { text },
  } as Memory;
  const result = await action.handler(runtime, message, undefined, {
    parameters: {
      subaction: "create_event",
      details: {
        title: "회의",
        startAt,
        endAt,
        timeZone: ZONE,
        grantId: "eliza-calendar",
        calendarId: "primary",
      },
      intent: text,
    },
  });
  return { result, create, runJsonModel, runTextModel };
}

describe("Calendar stated-year correction through the real handler", () => {
  it("creates the 2027 event instead of blocking it as a past 2026 date", async () => {
    const { result, create } = await runCreate(
      TEXT,
      "2027-01-05T15:00:00",
      "2027-01-05T16:00:00",
    );
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      startAt: "2027-01-05T06:00:00.000Z",
    });
    expect(result).toMatchObject({ success: true });
  });

  it("still blocks a genuinely past date (this year)", async () => {
    const { result, create } = await runCreate(
      "올해 1월 5일 오후 3시에 회의 잡아줘",
      "2026-01-05T15:00:00",
      "2026-01-05T16:00:00",
    );
    expect(create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      data: { missing: ["confirmed date"] },
    });
  });
});
