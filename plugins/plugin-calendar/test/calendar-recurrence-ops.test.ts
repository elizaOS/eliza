/**
 * Recurring-event (RRULE) guardrails for the CALENDAR action handler.
 *
 * The provider feed is flattened (`singleEvents: true`), so every occurrence
 * of a recurring series arrives as its own event carrying
 * `recurringEventId` → the series master. The mutation contract under test:
 *
 *   - update/delete of a recurring occurrence with NO instance-vs-series
 *     intent → clarification round-trip, NO mutation call
 *   - "just this …" phrasing / recurrenceScope=instance → mutation targets the
 *     occurrence id with scope "instance"
 *   - "whole series" phrasing / recurrenceScope=series → ONE mutation call with
 *     scope "series" (never an iteration over flattened occurrences)
 *   - non-recurring events keep the old behavior (no scope round-trip)
 *   - create_event carries structured RRULE recurrence through to the service
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
  recurringEventId?: string;
  recurrence?: string[];
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
    recurrence: args.recurrence ?? null,
    recurringEventId: args.recurringEventId ?? null,
    metadata: {
      ...(args.recurringEventId
        ? { recurringEventId: args.recurringEventId }
        : {}),
      ...(args.recurrence ? { recurrence: args.recurrence } : {}),
    },
    syncedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    grantId: "connector-account:acct-a",
  };
}

// One flattened occurrence of a weekly standup series.
const STANDUP_OCCURRENCE = event({
  externalId: "standup_20260708T170000Z",
  title: "Team Standup",
  recurringEventId: "standup-master",
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE"],
});

// A plain one-off event.
const LUNCH = event({ externalId: "evt-lunch", title: "Lunch with Maya" });

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
    createCalendarEvent: vi.fn(async () =>
      event({
        externalId: "evt-created",
        title: "Morning Run",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      }),
    ),
    deleteCalendarEvent: vi.fn(async () => undefined),
    updateCalendarEvent: vi.fn(async () => ({
      ...STANDUP_OCCURRENCE,
      title: "Team Standup (moved)",
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
  )) as { success: boolean; text: string; data?: Record<string, unknown> };
}

describe("CALENDAR update_event on a recurring occurrence", () => {
  let service: StubService;

  beforeEach(() => {
    service = stubService([STANDUP_OCCURRENCE, LUNCH]);
  });

  it("ambiguous intent → clarification, and nothing is updated", async () => {
    const result = await runHandler({
      service,
      text: "move my standup to 10am",
      parameters: { subaction: "update_event", query: "standup" },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("occurrence");
    expect(result.text).toContain("series");
    expect(result.data).toMatchObject({
      requiresInput: true,
      missing: ["recurrenceScope"],
    });
    expect(service.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it('"just this" phrasing → patches only the addressed occurrence', async () => {
    const result = await runHandler({
      service,
      text: "move just this standup to 10am",
      parameters: { subaction: "update_event", query: "standup" },
    });
    expect(result.success).toBe(true);
    expect(service.updateCalendarEvent).toHaveBeenCalledTimes(1);
    const request = service.updateCalendarEvent.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(request.eventId).toBe("standup_20260708T170000Z");
    expect(request.recurrenceScope).toBe("instance");
    expect(result.text).toContain("this occurrence only");
  });

  it('"whole series" phrasing → one series-scoped patch', async () => {
    const result = await runHandler({
      service,
      text: "rename the whole series of my standup",
      parameters: {
        subaction: "update_event",
        query: "standup",
        details: { newTitle: "Daily Sync" },
      },
    });
    expect(result.success).toBe(true);
    expect(service.updateCalendarEvent).toHaveBeenCalledTimes(1);
    const request = service.updateCalendarEvent.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(request.recurrenceScope).toBe("series");
    expect(request.title).toBe("Daily Sync");
    expect(result.text).toContain("whole series");
  });

  it("explicit recurrenceScope detail wins without special phrasing", async () => {
    const result = await runHandler({
      service,
      text: "move my standup to 10am",
      parameters: {
        subaction: "update_event",
        query: "standup",
        details: { recurrenceScope: "series" },
      },
    });
    expect(result.success).toBe(true);
    const request = service.updateCalendarEvent.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(request.recurrenceScope).toBe("series");
  });

  it("a recurrence-rule change is implicitly a series edit", async () => {
    const result = await runHandler({
      service,
      text: "make my standup weekly on tuesdays",
      parameters: {
        subaction: "update_event",
        query: "standup",
        details: { recurrence: "RRULE:FREQ=WEEKLY;BYDAY=TU" },
      },
    });
    expect(result.success).toBe(true);
    const request = service.updateCalendarEvent.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(request.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=TU"]);
    expect(request.recurrenceScope).toBe("series");
  });

  it("non-recurring events update without a scope round-trip", async () => {
    const result = await runHandler({
      service,
      text: "move my lunch with maya to 2pm",
      parameters: {
        subaction: "update_event",
        query: "lunch",
        details: { startAt: "2026-07-08T18:00:00.000Z" },
      },
    });
    expect(result.success).toBe(true);
    expect(service.updateCalendarEvent).toHaveBeenCalledTimes(1);
    const request = service.updateCalendarEvent.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(request.eventId).toBe("evt-lunch");
    expect(request.recurrenceScope).toBeUndefined();
  });
});

describe("CALENDAR delete_event on a recurring occurrence", () => {
  let service: StubService;

  beforeEach(() => {
    service = stubService([STANDUP_OCCURRENCE, LUNCH]);
  });

  it("ambiguous intent → clarification, and nothing is deleted", async () => {
    const result = await runHandler({
      service,
      text: "delete my standup",
      parameters: { subaction: "delete_event", query: "standup" },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("occurrence");
    expect(result.text).toContain("series");
    expect(service.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it('"just this" phrasing → deletes only the addressed occurrence', async () => {
    const result = await runHandler({
      service,
      text: "delete just this standup",
      parameters: { subaction: "delete_event", query: "standup" },
    });
    expect(result.success).toBe(true);
    expect(service.deleteCalendarEvent).toHaveBeenCalledTimes(1);
    const request = service.deleteCalendarEvent.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(request.eventId).toBe("standup_20260708T170000Z");
    expect(request.recurrenceScope).toBe("instance");
  });

  it('"whole series" phrasing → exactly one series-scoped delete call', async () => {
    const result = await runHandler({
      service,
      text: "delete the whole series of my standup",
      parameters: { subaction: "delete_event", query: "standup" },
    });
    expect(result.success).toBe(true);
    // One call with series scope — never an iteration over occurrences.
    expect(service.deleteCalendarEvent).toHaveBeenCalledTimes(1);
    const request = service.deleteCalendarEvent.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(request.recurrenceScope).toBe("series");
  });

  it("explicit eventId path forwards a structured recurrenceScope", async () => {
    const result = await runHandler({
      service,
      text: "delete that recurring meeting",
      parameters: {
        subaction: "delete_event",
        details: {
          eventId: "standup_20260708T170000Z",
          recurrenceScope: "series",
        },
      },
    });
    expect(result.success).toBe(true);
    expect(service.deleteCalendarEvent).toHaveBeenCalledTimes(1);
    const request = service.deleteCalendarEvent.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(request.eventId).toBe("standup_20260708T170000Z");
    expect(request.recurrenceScope).toBe("series");
  });

  it("non-recurring events delete without a scope round-trip", async () => {
    const result = await runHandler({
      service,
      text: "delete my lunch with maya",
      parameters: { subaction: "delete_event", query: "lunch" },
    });
    expect(result.success).toBe(true);
    expect(service.deleteCalendarEvent).toHaveBeenCalledTimes(1);
    const request = service.deleteCalendarEvent.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(request.eventId).toBe("evt-lunch");
    expect(request.recurrenceScope).toBeUndefined();
  });
});

describe("CALENDAR create_event with recurrence", () => {
  it("carries structured RRULE recurrence into the create request", async () => {
    const service = stubService([LUNCH]);
    const result = await runHandler({
      service,
      text: "book a morning run every monday at 1pm UTC",
      parameters: {
        subaction: "create_event",
        title: "Morning Run",
        details: {
          startAt: "2026-07-06T13:00:00.000Z",
          durationMinutes: 30,
          timeZone: "UTC",
          recurrence: "RRULE:FREQ=WEEKLY;BYDAY=MO",
        },
      },
    });
    expect(result.success).toBe(true);
    expect(service.createCalendarEvent).toHaveBeenCalledTimes(1);
    const request = service.createCalendarEvent.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(request.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
    // The grounded fallback reply names the repetition.
    expect(result.text).toContain("repeats weekly on Monday");
  });

  it("accepts recurrence via the rrule alias detail key", async () => {
    const service = stubService([LUNCH]);
    await runHandler({
      service,
      text: "book a morning run every monday at 1pm UTC",
      parameters: {
        subaction: "create_event",
        title: "Morning Run",
        details: {
          startAt: "2026-07-06T13:00:00.000Z",
          rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO",
        },
      },
    });
    const request = service.createCalendarEvent.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(request.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
  });

  it("one-off creates carry no recurrence", async () => {
    const service = stubService([LUNCH]);
    await runHandler({
      service,
      text: "book lunch tomorrow at 1pm UTC",
      parameters: {
        subaction: "create_event",
        title: "Lunch",
        details: { startAt: "2026-07-06T13:00:00.000Z" },
      },
    });
    const request = service.createCalendarEvent.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(request.recurrence).toBeUndefined();
  });
});
