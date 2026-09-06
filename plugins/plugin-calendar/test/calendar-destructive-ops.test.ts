/**
 * Destructive-op guardrails for the CALENDAR action handler.
 *
 * delete_event / update_event accept a fuzzy title and look events up across a
 * very wide window (−1y…+5y), so the disambiguation contract is load-bearing:
 *
 *   - explicit eventId            → resolves the provider target directly
 *   - unique title match          → queues one immutable approval
 *   - multiple title matches      → clarification round-trip, no approval
 *   - no match                    → not-found reply, no approval
 *
 * The CalendarService is stubbed (feed fixtures + spied mutations); the fake
 * runtime has no `useModel`; ordinary outcomes preserve internal evidence for
 * the evaluator. Exact approval previews remain interactive controls.
 */

import type { ActionResult, IAgentRuntime, Memory } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CalendarActionDeps,
  createCalendarActionRunner,
} from "../src/index.js";

function fakeDeps(service: StubService): CalendarActionDeps {
  return {
    runTextModel: vi.fn(async () => null),
    runJsonModel: vi.fn(async () => null),
    recentConversationTexts: vi.fn(async () => []),
    mutationGateway: {
      schedule: service.scheduleApproval,
      modify: service.modifyApproval,
      cancel: service.cancelApproval,
    },
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
const STANDUP_FRIDAY = event({
  externalId: "evt-3",
  title: "Standup",
  startAt: "2026-07-10T15:00:00.000Z",
});
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
      state: "complete" as const,
      sources: [
        {
          status: "fresh" as const,
        },
      ],
      timeMin: "2026-07-01T00:00:00.000Z",
      timeMax: "2026-07-31T00:00:00.000Z",
      syncedAt: null,
    })),
    getConditionalCalendarMutationTarget: vi.fn(
      async (_url: URL, request: { eventId: string }) =>
        feedEvents.find(
          (candidate) => candidate.externalId === request.eventId,
        ) ?? LUNCH_GRANDMA,
    ),
    deleteCalendarEvent: vi.fn(async () => undefined),
    updateCalendarEvent: vi.fn(async () => ({
      ...LUNCH_GRANDMA,
      title: "Lunch with Grandma (moved)",
    })),
    scheduleApproval: vi.fn(async () => ({
      requestId: "approval-schedule",
      action: "schedule_event" as const,
      state: "pending" as const,
      acceptedAt: "2026-07-01T12:00:00.000Z",
      idempotencyKey: "calendar-approval:schedule",
      replayed: false,
      text: "schedule approval queued",
    })),
    modifyApproval: vi.fn(async () => ({
      requestId: "approval-modify",
      action: "modify_event" as const,
      state: "pending" as const,
      acceptedAt: "2026-07-01T12:00:00.000Z",
      idempotencyKey: "calendar-approval:modify",
      replayed: false,
      text: "modify approval queued",
    })),
    cancelApproval: vi.fn(async () => ({
      requestId: "approval-cancel",
      action: "cancel_event" as const,
      state: "pending" as const,
      acceptedAt: "2026-07-01T12:00:00.000Z",
      idempotencyKey: "calendar-approval:cancel",
      replayed: false,
      text: "cancel approval queued",
    })),
  };
}

type StubService = ReturnType<typeof stubService>;

function fakeRuntime(service: StubService): IAgentRuntime {
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
  const action = createCalendarActionRunner(fakeDeps(args.service));
  const callback = vi.fn(async () => []);
  const result = await action.handler(
    fakeRuntime(args.service),
    message(args.text),
    undefined,
    { parameters: args.parameters },
    callback,
  );
  if (!result) throw new Error("Expected a Calendar action result");
  expect(result.effectReceipts).toHaveLength(1);
  if (result.transcriptVisibility === "internal") {
    expectInternalHandoff(result, callback);
  } else {
    expect(result.turnComplete).toBe(true);
    expect(result.userFacingText).toBe(result.text);
    expect(result.userFacingEffectReceiptIds).toEqual([
      result.effectReceipts?.[0]?.receiptId,
    ]);
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      text: result.text,
      source: "action",
      action: "CALENDAR",
    });
  }
  return result;
}

function expectInternalHandoff(
  result: ActionResult,
  callback: ReturnType<typeof vi.fn>,
): void {
  expect(callback).not.toHaveBeenCalled();
  // Settled internal results omit turnComplete (evaluation delegated); pauses keep false.
  expect(result.turnComplete).not.toBe(true);
  expect(result).not.toHaveProperty("text");
  expect(result).not.toHaveProperty("userFacingText");
  expect(result.data?.replyContext).toMatchObject({
    domain: "calendar",
    intent: expect.any(String),
    scenario: expect.any(String),
    facts: expect.stringMatching(/\S/),
    context: expect.any(Object),
  });
}

function replyFacts(result: ActionResult): string {
  const replyContext = result.data?.replyContext;
  if (
    !replyContext ||
    typeof replyContext !== "object" ||
    Array.isArray(replyContext) ||
    typeof replyContext.facts !== "string"
  ) {
    throw new Error("Expected Calendar internal reply facts");
  }
  return replyContext.facts;
}

describe("CALENDAR delete_event disambiguation", () => {
  let service: StubService;

  beforeEach(() => {
    service = stubService([LUNCH_MAYA, LUNCH_GRANDMA]);
  });

  it.each(["title", "details.title"])(
    "uses %s as the deletion target without a redundant query",
    async (field) => {
      const result = await runHandler({
        service,
        text: "delete lunch with grandma",
        parameters: {
          subaction: "delete_event",
          ...(field === "title"
            ? { title: "Lunch with Grandma" }
            : {
                details: { title: "Lunch with Grandma", calendarId: "primary" },
              }),
        },
      });
      expect(result.success).toBe(true);
      expect(service.cancelApproval).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ targetEvent: LUNCH_GRANDMA }),
      );
      expect(service.deleteCalendarEvent).not.toHaveBeenCalled();
    },
  );

  it("does not choose between duplicate supplied titles", async () => {
    service = stubService([
      LUNCH_GRANDMA,
      event({ externalId: "evt-duplicate", title: LUNCH_GRANDMA.title }),
    ]);
    const result = await runHandler({
      service,
      text: "delete lunch with grandma",
      parameters: {
        subaction: "delete_event",
        details: { title: LUNCH_GRANDMA.title },
      },
    });
    expect(result.success).toBe(false);
    expect(replyFacts(result)).toContain("multiple");
    expect(service.cancelApproval).not.toHaveBeenCalled();
    expect(service.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("does not mutate when the supplied title has no match", async () => {
    const result = await runHandler({
      service,
      text: "delete standup",
      parameters: { subaction: "delete_event", title: "Standup" },
    });
    expect(result.success).toBe(false);
    expect(replyFacts(result)).toContain("couldn't find");
    expect(service.cancelApproval).not.toHaveBeenCalled();
    expect(service.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("keeps an explicit query ahead of the title fallback", async () => {
    const result = await runHandler({
      service,
      text: "delete lunch with maya",
      parameters: {
        subaction: "delete_event",
        query: "Maya",
        title: "Lunch with Grandma",
      },
    });
    expect(result.success).toBe(true);
    expect(service.cancelApproval).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ targetEvent: LUNCH_MAYA }),
    );
  });

  it("ambiguous fuzzy title → clarification, and nothing is deleted", async () => {
    const result = await runHandler({
      service,
      text: "delete my lunch",
      parameters: { subaction: "delete_event", query: "lunch" },
    });
    expect(result.success).toBe(false);
    expect(replyFacts(result)).toContain("multiple");
    expect(replyFacts(result)).toContain("Lunch with Maya");
    expect(replyFacts(result)).toContain("Lunch with Grandma");
    expect(service.cancelApproval).not.toHaveBeenCalled();
    expect(service.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("unique title match → proceeds against exactly that event", async () => {
    const result = await runHandler({
      service,
      text: "delete lunch with grandma",
      parameters: { subaction: "delete_event", query: "grandma" },
    });
    expect(result.success).toBe(true);
    expect(service.cancelApproval).toHaveBeenCalledTimes(1);
    expect(service.cancelApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        targetEvent: LUNCH_GRANDMA,
        request: expect.objectContaining({
          eventId: LUNCH_GRANDMA.externalId,
          calendarId: LUNCH_GRANDMA.calendarId,
          grantId: LUNCH_GRANDMA.grantId,
        }),
      }),
    );
    expect(service.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("a multi-target message lets the per-target intent pick the day instead of the message's first date", async () => {
    // Live 2026-09-05 22:44: three deletes in one message were all constrained
    // to the first stated day, so two existing events came back "not found".
    const multi = stubService([LUNCH_MAYA, LUNCH_GRANDMA, STANDUP_FRIDAY]);
    const result = await runHandler({
      service: multi,
      text: "delete lunch with maya on 2026-07-08 and the standup on 2026-07-10 from my calendar",
      parameters: {
        subaction: "delete_event",
        query: "standup",
        intent: "delete the standup on 2026-07-10 from my calendar",
      },
    });
    expect(result.success).toBe(true);
    expect(multi.cancelApproval).toHaveBeenCalledWith(
      expect.objectContaining({ targetEvent: STANDUP_FRIDAY }),
    );
  });

  it("the user's stated day outranks a wrong planner date detail", async () => {
    // Live 2026-09-05 23:33: "delete the haircut on sunday" came with
    // details.date for the Monday, so the lookup missed the Sunday event.
    const result = await runHandler({
      service,
      text: "delete lunch with grandma on 2026-07-08",
      parameters: {
        subaction: "delete_event",
        query: "grandma",
        details: { date: "2026-07-09", timeZone: "UTC" },
      },
    });
    expect(result.success).toBe(true);
    expect(service.cancelApproval).toHaveBeenCalledWith(
      expect.objectContaining({ targetEvent: LUNCH_GRANDMA }),
    );
  });

  it("a multi-target message with no per-target intent uses the planner's date detail, not the message's first day", async () => {
    // Live 2026-09-06 00:16: "delete the yoga class on thursday and the dentist
    // visit on friday" — the dentist call carried date=Friday but no intent, and
    // the lookup was constrained to Thursday, so the Friday event was missed.
    const multi = stubService([LUNCH_MAYA, LUNCH_GRANDMA, STANDUP_FRIDAY]);
    const result = await runHandler({
      service: multi,
      text: "delete lunch with maya on 2026-07-08 and the standup on 2026-07-10 from my calendar",
      parameters: {
        subaction: "delete_event",
        title: "Standup",
        query: "standup friday",
        details: { date: "2026-07-10", timeZone: "UTC" },
      },
    });
    expect(result.success).toBe(true);
    expect(multi.cancelApproval).toHaveBeenCalledWith(
      expect.objectContaining({ targetEvent: STANDUP_FRIDAY }),
    );
  });

  it("typed delete_event + title (no query) → reads the feed and targets that event", async () => {
    // ROOT trace step-1788648925553-vzj6rq (2026-09-05): the planner sent
    // subaction=delete_event with the exact title and a date; the handler
    // discarded the title and asked which event, without any lookup.
    const result = await runHandler({
      service,
      text: "clean up the two QA events",
      parameters: {
        subaction: "delete_event",
        title: "Lunch with Grandma",
        details: { date: "2026-07-08", timeZone: "UTC" },
      },
    });
    expect(result.success).toBe(true);
    expect(service.getCalendarFeed).toHaveBeenCalledTimes(1);
    expect(service.cancelApproval).toHaveBeenCalledWith(
      expect.objectContaining({ targetEvent: LUNCH_GRANDMA }),
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
    expect(service.getConditionalCalendarMutationTarget).toHaveBeenCalledTimes(
      1,
    );
    expect(service.cancelApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          eventId: "evt-2",
          calendarId: "primary",
        }),
      }),
    );
    expect(service.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("no match → not-found reply, and nothing is deleted", async () => {
    const result = await runHandler({
      service,
      text: "delete the standup",
      parameters: { subaction: "delete_event", query: "standup" },
    });
    expect(result.success).toBe(false);
    expect(replyFacts(result)).toContain("couldn't find");
    expect(service.cancelApproval).not.toHaveBeenCalled();
    expect(service.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("hands off grounded facts without invoking the action reply renderer", async () => {
    const renderGroundedReply = vi.fn(
      async ({ fallback }: { fallback: string }) => ({
        kind: "model" as const,
        text: `Human-readable: ${fallback}`,
      }),
    );
    const action = createCalendarActionRunner({
      ...fakeDeps(service),
      renderGroundedReply,
    });

    const callback = vi.fn(async () => []);
    const result = await action.handler(
      fakeRuntime(service),
      message("delete the standup"),
      undefined,
      {
        parameters: { subaction: "delete_event", query: "standup" },
      },
      callback,
    );
    if (!result) throw new Error("Expected a Calendar action result");
    expect(result.success).toBe(false);
    expectInternalHandoff(result, callback);
    expect(result.effectReceipts).toEqual([
      expect.objectContaining({
        operation: "calendar.event.delete",
        outcome: "noop",
      }),
    ]);
    expect(result.data?.replyContext).toMatchObject({
      intent: "delete the standup",
      scenario: "delete_event_not_found",
      facts: expect.stringContaining("couldn't find"),
      context: { titleHint: "standup" },
    });
    expect(renderGroundedReply).not.toHaveBeenCalled();
    expect(service.cancelApproval).not.toHaveBeenCalled();
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
    expect(replyFacts(result)).toContain("multiple");
    expect(service.modifyApproval).not.toHaveBeenCalled();
    expect(service.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it("unique title match → proceeds against exactly that event", async () => {
    const result = await runHandler({
      service,
      text: "move lunch with grandma to 6pm",
      parameters: { subaction: "update_event", query: "grandma" },
    });
    expect(result.success).toBe(true);
    expect(service.modifyApproval).toHaveBeenCalledTimes(1);
    expect(service.modifyApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        targetEvent: LUNCH_GRANDMA,
        request: expect.objectContaining({
          eventId: LUNCH_GRANDMA.externalId,
          calendarId: LUNCH_GRANDMA.calendarId,
          grantId: LUNCH_GRANDMA.grantId,
        }),
      }),
    );
    expect(service.updateCalendarEvent).not.toHaveBeenCalled();
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
    expect(service.getConditionalCalendarMutationTarget).toHaveBeenCalledTimes(
      1,
    );
    expect(service.modifyApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          eventId: "evt-2",
          calendarId: "primary",
        }),
      }),
    );
    expect(service.updateCalendarEvent).not.toHaveBeenCalled();
  });
});
