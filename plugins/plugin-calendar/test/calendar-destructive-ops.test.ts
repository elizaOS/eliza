/**
 * Destructive-op guardrails for the CALENDAR action handler.
 *
 * delete_event / update_event accept a fuzzy title and look events up across a
 * very wide window (−1y…+5y), so the disambiguation contract is load-bearing:
 *
 *   - explicit eventId            → proceeds directly (no feed lookup)
 *   - unique title match          → proceeds against that event
 *   - multiple title matches      → clarification round-trip, NO destructive call
 *   - no match                    → not-found reply, NO destructive call
 *
 * The CalendarService is stubbed (feed fixtures + spied mutations); the fake
 * runtime has no `useModel`, so replies deterministically use the handler's
 * canonical fallback strings.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CalendarActionDeps,
  createCalendarActionRunner,
} from "../src/index.js";

function fakeDeps(): CalendarActionDeps {
  return {
    runTextModel: vi.fn(async () => null),
    runJsonModel: vi.fn(async () => null),
    recentConversationTexts: vi.fn(async () => []),
  };
}

function event(args: {
  externalId: string;
  title: string;
  startAt?: string;
}): LifeOpsCalendarEvent {
  const startAt = args.startAt ?? "2026-07-08T17:00:00.000Z";
  return {
    id: `agent-1:google:owner:calendar:primary:${args.externalId}`,
    externalId: args.externalId,
    agentId: "agent-1",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: args.title,
    description: "",
    location: "",
    status: "confirmed",
    startAt,
    endAt: "2026-07-08T18:00:00.000Z",
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    grantId: "connector-account:acct-a",
  };
}

const LUNCH_MAYA = event({ externalId: "evt-1", title: "Lunch with Maya" });
const LUNCH_GRANDMA = event({
  externalId: "evt-2",
  title: "Lunch with Grandma",
});

function stubService(feedEvents: LifeOpsCalendarEvent[]) {
  return {
    getCalendarFeed: vi.fn(async () => ({
      calendarId: "all",
      events: feedEvents,
      source: "cache" as const,
      timeMin: "2026-07-01T00:00:00.000Z",
      timeMax: "2026-07-31T00:00:00.000Z",
      syncedAt: null,
    })),
    deleteCalendarEvent: vi.fn(async () => undefined),
    updateCalendarEvent: vi.fn(async () => ({
      ...LUNCH_GRANDMA,
      title: "Lunch with Grandma (moved)",
    })),
  };
}

type StubService = ReturnType<typeof stubService>;

function fakeRuntime(service: StubService): IAgentRuntime {
  // No `useModel` on purpose: renderGroundedActionReply then returns the
  // handler's canonical fallback strings verbatim.
  return {
    agentId: "agent-1",
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    getService: (name: string) => (name === "calendar" ? service : null),
  } as unknown as IAgentRuntime;
}

function message(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000101",
    entityId: "00000000-0000-0000-0000-000000000102",
    roomId: "00000000-0000-0000-0000-000000000103",
    content: { text },
  } as unknown as Memory;
}

async function runHandler(args: {
  service: StubService;
  text: string;
  parameters: Record<string, unknown>;
}) {
  const action = createCalendarActionRunner(fakeDeps());
  return (await action.handler(
    fakeRuntime(args.service),
    message(args.text),
    undefined,
    { parameters: args.parameters },
    undefined,
  )) as { success: boolean; text: string };
}

describe("CALENDAR delete_event disambiguation", () => {
  let service: StubService;

  beforeEach(() => {
    service = stubService([LUNCH_MAYA, LUNCH_GRANDMA]);
  });

  it("ambiguous fuzzy title → clarification, and nothing is deleted", async () => {
    const result = await runHandler({
      service,
      text: "delete my lunch",
      parameters: { subaction: "delete_event", query: "lunch" },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("multiple");
    expect(result.text).toContain("Lunch with Maya");
    expect(result.text).toContain("Lunch with Grandma");
    expect(service.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("unique title match → proceeds against exactly that event", async () => {
    const result = await runHandler({
      service,
      text: "delete lunch with grandma",
      parameters: { subaction: "delete_event", query: "grandma" },
    });
    expect(result.success).toBe(true);
    expect(service.deleteCalendarEvent).toHaveBeenCalledTimes(1);
    expect(service.deleteCalendarEvent).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        eventId: LUNCH_GRANDMA.externalId,
        calendarId: LUNCH_GRANDMA.calendarId,
        grantId: LUNCH_GRANDMA.grantId,
      }),
    );
  });

  it("explicit eventId → proceeds directly without a feed lookup", async () => {
    const result = await runHandler({
      service,
      text: "delete that event",
      parameters: {
        subaction: "delete_event",
        details: { eventId: "evt-2", calendarId: "primary" },
      },
    });
    expect(result.success).toBe(true);
    expect(service.getCalendarFeed).not.toHaveBeenCalled();
    expect(service.deleteCalendarEvent).toHaveBeenCalledTimes(1);
    expect(service.deleteCalendarEvent).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ eventId: "evt-2", calendarId: "primary" }),
    );
  });

  it("no match → not-found reply, and nothing is deleted", async () => {
    const result = await runHandler({
      service,
      text: "delete the standup",
      parameters: { subaction: "delete_event", query: "standup" },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("couldn't find");
    expect(service.deleteCalendarEvent).not.toHaveBeenCalled();
  });
});

describe("CALENDAR update_event disambiguation", () => {
  let service: StubService;

  beforeEach(() => {
    service = stubService([LUNCH_MAYA, LUNCH_GRANDMA]);
  });

  it("ambiguous fuzzy title → clarification, and nothing is updated", async () => {
    const result = await runHandler({
      service,
      text: "move my lunch to 6pm",
      parameters: { subaction: "update_event", query: "lunch" },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("multiple");
    expect(service.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it("unique title match → proceeds against exactly that event", async () => {
    const result = await runHandler({
      service,
      text: "move lunch with grandma to 6pm",
      parameters: { subaction: "update_event", query: "grandma" },
    });
    expect(result.success).toBe(true);
    expect(service.updateCalendarEvent).toHaveBeenCalledTimes(1);
    expect(service.updateCalendarEvent).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        eventId: LUNCH_GRANDMA.externalId,
        calendarId: LUNCH_GRANDMA.calendarId,
        grantId: LUNCH_GRANDMA.grantId,
      }),
    );
  });

  it("explicit eventId → proceeds directly without a feed lookup", async () => {
    const result = await runHandler({
      service,
      text: "rename that event",
      parameters: {
        subaction: "update_event",
        title: "Lunch with Grandma (moved)",
        details: { eventId: "evt-2", calendarId: "primary" },
      },
    });
    expect(result.success).toBe(true);
    expect(service.getCalendarFeed).not.toHaveBeenCalled();
    expect(service.updateCalendarEvent).toHaveBeenCalledTimes(1);
    expect(service.updateCalendarEvent).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ eventId: "evt-2", calendarId: "primary" }),
    );
  });
});
