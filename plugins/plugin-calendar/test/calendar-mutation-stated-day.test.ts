/**
 * Regression coverage for target resolution on the CALENDAR mutation branches:
 * a day the user themselves named must narrow the candidate set before the
 * handler declares the request ambiguous.
 *
 * Live capture (2026-08-14): "cancel my haircut on friday" and "change my
 * haircut on saturday to 2pm" both answered "found two haircuts: friday at 11am
 * and saturday at 1pm — which one?", turning a one-turn mutation into two even
 * though the user's own words selected exactly one event. The same reply mixed
 * zones ("11am pdt" … "1pm utc") because each candidate rendered in its own
 * provider zone.
 *
 * The CalendarService is stubbed (feed fixture + spied mutations) and the fake
 * runtime has no `useModel`; ordinary outcomes hand complete internal evidence
 * to the evaluator and the planner contributes no time window — the live shape,
 * where the day survives only in the user's text. The clock is pinned so
 * "friday"/"saturday" resolve deterministically.
 */

import type { ActionResult, IAgentRuntime, Memory } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CalendarActionDeps,
  createCalendarActionRunner,
} from "../src/index.js";

/** Wednesday 2026-08-12, 05:00 in America/Los_Angeles. */
const PINNED_NOW = new Date("2026-08-12T12:00:00.000Z");
const OWNER_TIME_ZONE = "America/Los_Angeles";

function event(args: {
  externalId: string;
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
}): LifeOpsCalendarEvent {
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
    startAt: args.startAt,
    endAt: args.endAt,
    isAllDay: false,
    timezone: args.timezone,
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    grantId: "connector-account:acct-a",
  };
}

/** Friday Aug 14, 11:00 AM PDT. */
const HAIRCUT_FRIDAY = event({
  externalId: "evt-fri",
  title: "Haircut",
  startAt: "2026-08-14T18:00:00.000Z",
  endAt: "2026-08-14T18:30:00.000Z",
  timezone: OWNER_TIME_ZONE,
});

/** Saturday Aug 15, 1:00 PM UTC — a second source, in a different zone. */
const HAIRCUT_SATURDAY = event({
  externalId: "evt-sat",
  title: "Haircut",
  startAt: "2026-08-15T13:00:00.000Z",
  endAt: "2026-08-15T13:30:00.000Z",
  timezone: "UTC",
});

function localEvent(source: LifeOpsCalendarEvent): LifeOpsCalendarEvent {
  return {
    ...source,
    provider: "eliza",
    grantId: "eliza-calendar",
    metadata: { etag: '"eliza-1"', version: 1 },
  };
}

function stubService(feedEvents: LifeOpsCalendarEvent[]) {
  return {
    getCalendarFeed: vi.fn(async () => ({
      calendarId: "all",
      events: feedEvents,
      source: "cache" as const,
      state: "complete" as const,
      sources: [{ status: "fresh" as const }],
      timeMin: "2025-08-12T00:00:00.000Z",
      timeMax: "2031-08-12T00:00:00.000Z",
      syncedAt: null,
    })),
    getConditionalCalendarMutationTarget: vi.fn(
      async (_url: URL, request: { eventId: string }) =>
        feedEvents.find(
          (candidate) => candidate.externalId === request.eventId,
        ) ?? HAIRCUT_FRIDAY,
    ),
    deleteCalendarEvent: vi.fn(async () => undefined),
    updateCalendarEvent: vi.fn(async () => HAIRCUT_SATURDAY),
    prepareCalendarEventCreate: vi.fn(
      async (_url: URL, request: Record<string, unknown>) => request,
    ),
    scheduleApproval: vi.fn(async () => ({
      requestId: "approval-schedule",
      action: "schedule_event" as const,
      state: "pending" as const,
      acceptedAt: "2026-08-12T12:00:00.000Z",
      idempotencyKey: "calendar-approval:schedule",
      replayed: false,
      text: "schedule approval queued",
    })),
    modifyApproval: vi.fn(async () => ({
      requestId: "approval-modify",
      action: "modify_event" as const,
      state: "pending" as const,
      acceptedAt: "2026-08-12T12:00:00.000Z",
      idempotencyKey: "calendar-approval:modify",
      replayed: false,
      text: "modify approval queued",
    })),
    cancelApproval: vi.fn(async () => ({
      requestId: "approval-cancel",
      action: "cancel_event" as const,
      state: "pending" as const,
      acceptedAt: "2026-08-12T12:00:00.000Z",
      idempotencyKey: "calendar-approval:cancel",
      replayed: false,
      text: "cancel approval queued",
    })),
  };
}

type StubService = ReturnType<typeof stubService>;

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

function fakeRuntime(service: StubService): IAgentRuntime {
  return {
    agentId: "agent-1",
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    reportError: vi.fn(),
    getService: (name: string) => (name === "calendar" ? service : null),
  } as unknown as IAgentRuntime;
}

function message(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000201",
    entityId: "00000000-0000-0000-0000-000000000202",
    roomId: "00000000-0000-0000-0000-000000000203",
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
    expect(callback).not.toHaveBeenCalled();
    expect(result.turnComplete).toBe(false);
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("userFacingText");
    expect(result.data?.replyContext).toMatchObject({
      domain: "calendar",
      intent: args.text,
      scenario: expect.any(String),
      facts: expect.stringMatching(/\S/),
      context: expect.any(Object),
    });
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

describe("CALENDAR mutation target honors the day the user stated", () => {
  let service: StubService;

  beforeEach(() => {
    // Only Date is faked: the handler awaits real promises.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED_NOW);
    service = stubService([HAIRCUT_FRIDAY, HAIRCUT_SATURDAY]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('"cancel my haircut on friday" cancels the friday one without asking', async () => {
    const result = await runHandler({
      service,
      text: "cancel my haircut on friday",
      parameters: {
        subaction: "delete_event",
        query: "haircut",
        details: { timeZone: OWNER_TIME_ZONE },
      },
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("cancel approval queued");
    expect(service.cancelApproval).toHaveBeenCalledTimes(1);
    expect(service.cancelApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        targetEvent: HAIRCUT_FRIDAY,
        request: expect.objectContaining({
          eventId: HAIRCUT_FRIDAY.externalId,
        }),
      }),
    );
  });

  it('"change my haircut on saturday to 2pm" targets the saturday one', async () => {
    const result = await runHandler({
      service,
      text: "change my haircut on saturday to 2pm",
      parameters: {
        subaction: "update_event",
        query: "haircut",
        details: { timeZone: OWNER_TIME_ZONE },
      },
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("modify approval queued");
    expect(service.modifyApproval).toHaveBeenCalledTimes(1);
    expect(service.modifyApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        targetEvent: HAIRCUT_SATURDAY,
        request: expect.objectContaining({
          eventId: HAIRCUT_SATURDAY.externalId,
        }),
      }),
    );
  });

  it("a stated day that matches no candidate cannot fall back to another day", async () => {
    const result = await runHandler({
      service,
      text: "cancel my haircut on sunday",
      parameters: {
        subaction: "delete_event",
        query: "haircut",
        details: { timeZone: OWNER_TIME_ZONE },
      },
    });

    expect(result.success).toBe(false);
    expect(replyFacts(result)).toContain("couldn't find");
    expect(service.cancelApproval).not.toHaveBeenCalled();
  });

  describe.each(["update_event", "delete_event"] as const)(
    "%s enriched target identity",
    (subaction) => {
      const targetDetails = {
        timeZone: OWNER_TIME_ZONE,
        ...(subaction === "update_event"
          ? { newTitle: "Updated appointment" }
          : {}),
      };

      function expectNoMutation(targetService: StubService) {
        expect(targetService.modifyApproval).not.toHaveBeenCalled();
        expect(targetService.cancelApproval).not.toHaveBeenCalled();
        expect(targetService.updateCalendarEvent).not.toHaveBeenCalled();
        expect(targetService.deleteCalendarEvent).not.toHaveBeenCalled();
      }

      it("does not select Project A for an enriched Project B hint", async () => {
        const projectA = localEvent({ ...HAIRCUT_FRIDAY, title: "Project A" });
        const targetService = stubService([projectA]);
        const result = await runHandler({
          service: targetService,
          text: `${subaction === "update_event" ? "rename" : "cancel"} Project B on August 14 2026`,
          parameters: {
            subaction,
            query: "Project B August 14 2026 11:00",
            details: targetDetails,
          },
        });
        expectNoMutation(targetService);
        expect(result.success).toBe(false);
      });

      it("cannot mutate the only title match when the user named another date", async () => {
        const targetService = stubService([localEvent(HAIRCUT_FRIDAY)]);
        const result = await runHandler({
          service: targetService,
          text: `${subaction === "update_event" ? "rename" : "cancel"} my haircut on August 15 2026`,
          parameters: {
            subaction,
            query: "Haircut August 15 2026 6:00",
            details: targetDetails,
          },
        });
        expectNoMutation(targetService);
        expect(result.success).toBe(false);
      });

      it("honors the target date carried only in an enriched planner hint", async () => {
        const targetService = stubService([localEvent(HAIRCUT_FRIDAY)]);
        const result = await runHandler({
          service: targetService,
          text:
            subaction === "update_event"
              ? "rename that appointment"
              : "cancel that appointment",
          parameters: {
            subaction,
            query: "Haircut August 15 2026 6:00",
            details: targetDetails,
          },
        });
        expectNoMutation(targetService);
        expect(result.success).toBe(false);
      });

      it("keeps the richer hint's exact title and matching date usable", async () => {
        const projectA = { ...HAIRCUT_FRIDAY, title: "Project A" };
        const projectB = { ...HAIRCUT_SATURDAY, title: "Project B" };
        const targetService = stubService([projectA, projectB]);
        const result = await runHandler({
          service: targetService,
          text: `${subaction === "update_event" ? "rename" : "cancel"} Project B on August 15 2026`,
          parameters: {
            subaction,
            query: "Project B August 15 2026 6:00",
            details: targetDetails,
          },
        });
        expect(result.success).toBe(true);
        const approval =
          subaction === "update_event"
            ? targetService.modifyApproval
            : targetService.cancelApproval;
        expect(approval).toHaveBeenCalledTimes(1);
        expect(approval).toHaveBeenCalledWith(
          expect.objectContaining({ targetEvent: projectB }),
        );
        expect(targetService.updateCalendarEvent).not.toHaveBeenCalled();
        expect(targetService.deleteCalendarEvent).not.toHaveBeenCalled();
      });

      it("keeps same-title events on the stated day ambiguous", async () => {
        const secondFriday = {
          ...HAIRCUT_FRIDAY,
          id: "second-friday",
          externalId: "evt-fri-later",
          startAt: "2026-08-14T20:00:00.000Z",
          endAt: "2026-08-14T20:30:00.000Z",
        };
        const targetService = stubService([
          HAIRCUT_FRIDAY,
          secondFriday,
          HAIRCUT_SATURDAY,
        ]);
        const result = await runHandler({
          service: targetService,
          text: `${subaction === "update_event" ? "rename" : "cancel"} my haircut on August 14 2026`,
          parameters: {
            subaction,
            query: "Haircut August 14 2026",
            details: targetDetails,
          },
        });
        expectNoMutation(targetService);
        expect(result.success).toBe(false);
        expect(replyFacts(result)).toContain("multiple");
      });
    },
  );

  it("a day that only names where the event is going does not pick a target", async () => {
    // "to friday" is the new time, not the target — retargeting on it would
    // move whichever haircut happens to already sit on friday.
    const result = await runHandler({
      service,
      text: "move my haircut to friday 2pm",
      parameters: {
        subaction: "update_event",
        query: "haircut",
        details: { timeZone: OWNER_TIME_ZONE },
      },
    });

    expect(result.success).toBe(false);
    expect(replyFacts(result)).toContain("multiple");
    expect(service.modifyApproval).not.toHaveBeenCalled();
  });

  it("an enriched query cannot turn an update destination into the target date", async () => {
    const result = await runHandler({
      service,
      text: "move my haircut to August 14 2026 at 2pm",
      parameters: {
        subaction: "update_event",
        query: "Haircut August 14 2026 2pm",
        details: { timeZone: OWNER_TIME_ZONE },
      },
    });
    expect(result.success).toBe(false);
    expect(replyFacts(result)).toContain("multiple");
    expect(service.modifyApproval).not.toHaveBeenCalled();
    expect(service.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it.each([
    "change that appointment to 2pm",
    "move my haircut to August 15 2026 at 2pm",
  ])(
    "rejects a conflicting unique dated query on a destination-bearing update: %s",
    async (text) => {
      const targetService = stubService([localEvent(HAIRCUT_FRIDAY)]);
      const result = await runHandler({
        service: targetService,
        text,
        parameters: {
          subaction: "update_event",
          query: "Haircut August 15 2026",
          details: {
            timeZone: OWNER_TIME_ZONE,
            newTitle: "Updated appointment",
          },
        },
      });
      expect(targetService.modifyApproval).not.toHaveBeenCalled();
      expect(targetService.cancelApproval).not.toHaveBeenCalled();
      expect(targetService.updateCalendarEvent).not.toHaveBeenCalled();
      expect(targetService.deleteCalendarEvent).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    },
  );

  it.each([
    {
      text: "move my haircut on August 14 2026 to August 15 2026 at 2pm",
      query: "Haircut August 15 2026",
    },
    {
      text: "move my haircut to August 15 2026 at 2pm",
      query: "Haircut",
    },
    {
      text: "change that appointment to 2pm",
      query: "Haircut August 14 2026",
    },
  ])(
    "keeps an unambiguous unique update target usable: $text / $query",
    async ({ text, query }) => {
      const targetService = stubService([HAIRCUT_FRIDAY]);
      const result = await runHandler({
        service: targetService,
        text,
        parameters: {
          subaction: "update_event",
          query,
          details: {
            timeZone: OWNER_TIME_ZONE,
            newTitle: "Updated appointment",
          },
        },
      });
      expect(result.success).toBe(true);
      expect(targetService.modifyApproval).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ targetEvent: HAIRCUT_FRIDAY }),
      );
      expect(targetService.cancelApproval).not.toHaveBeenCalled();
      expect(targetService.updateCalendarEvent).not.toHaveBeenCalled();
      expect(targetService.deleteCalendarEvent).not.toHaveBeenCalled();
    },
  );

  it("lists remaining candidates in one timezone", async () => {
    const result = await runHandler({
      service,
      text: "cancel my haircut",
      parameters: {
        subaction: "delete_event",
        query: "haircut",
        details: { timeZone: OWNER_TIME_ZONE },
      },
    });

    expect(result.success).toBe(false);
    expect(replyFacts(result)).toContain("Aug 14, 11:00 AM PDT");
    expect(replyFacts(result)).toContain("Aug 15, 6:00 AM PDT");
    expect(replyFacts(result)).not.toContain("UTC");
    expect(service.cancelApproval).not.toHaveBeenCalled();
  });
});

describe("CALENDAR create honors the day the user stated", () => {
  let service: StubService;

  beforeEach(() => {
    // Saturday 2026-08-15, so "sunday" = Aug 16. Only Date is faked.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
    service = stubService([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("snaps a planner start on the wrong day onto the stated day, keeping wall time", async () => {
    // Live capture (2026-08-15): "put coffee with dana on my calendar sunday
    // at 10am", asked on a Saturday, arrived with a Monday startAt — the
    // model's weekday arithmetic slipped while the user's word did not.
    const result = await runHandler({
      service,
      text: "put coffee with dana on my calendar sunday at 10am",
      parameters: {
        subaction: "create_event",
        title: "coffee with dana",
        details: {
          startAt: "2026-08-17T10:00:00.000Z",
          endAt: "2026-08-17T11:00:00.000Z",
          timeZone: "UTC",
        },
      },
    });
    expect(result.success).toBe(true);
    expect(service.scheduleApproval).toHaveBeenCalledTimes(1);
    const scheduled = (
      service.scheduleApproval.mock.calls[0]?.[0] as {
        request?: { startAt?: string; endAt?: string };
      }
    )?.request;
    expect(scheduled?.startAt).toBe("2026-08-16T10:00:00.000Z");
    expect(scheduled?.endAt).toBe("2026-08-16T11:00:00.000Z");
  });

  it("changes nothing when the planner date already matches the stated day", async () => {
    const result = await runHandler({
      service,
      text: "put coffee with dana on my calendar sunday at 10am",
      parameters: {
        subaction: "create_event",
        title: "coffee with dana",
        details: {
          startAt: "2026-08-16T10:00:00.000Z",
          endAt: "2026-08-16T11:00:00.000Z",
          timeZone: "UTC",
        },
      },
    });
    expect(result.success).toBe(true);
    const scheduled = (
      service.scheduleApproval.mock.calls[0]?.[0] as {
        request?: { startAt?: string };
      }
    )?.request;
    expect(scheduled?.startAt).toBe("2026-08-16T10:00:00.000Z");
  });

  it("changes nothing when the user named no date", async () => {
    const result = await runHandler({
      service,
      text: "put coffee with dana on my calendar",
      parameters: {
        subaction: "create_event",
        title: "coffee with dana",
        details: {
          startAt: "2026-08-17T10:00:00.000Z",
          endAt: "2026-08-17T11:00:00.000Z",
          timeZone: "UTC",
        },
      },
    });
    expect(result.success).toBe(true);
    const scheduled = (
      service.scheduleApproval.mock.calls[0]?.[0] as {
        request?: { startAt?: string };
      }
    )?.request;
    expect(scheduled?.startAt).toBe("2026-08-17T10:00:00.000Z");
  });
});
