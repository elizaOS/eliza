/**
 * Checks typed Calendar search routing through the real action runner with
 * a controlled feed and model ports. Valid filters read without inference;
 * missing filters return a repairable error before any feed or model call.
 */
import {
  executePlannedToolCall,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  actionResultToPlannerToolResult,
  runPlannerLoop,
} from "../../plugin-assistant/src/runtime/planner-loop.ts";
import {
  type CalendarActionDeps,
  createCalendarActionRunner,
} from "../src/index.js";
import { CalendarServiceError } from "../src/internal/errors.js";

const EVENT: LifeOpsCalendarEvent = {
  id: "agent-1:eliza:owner:calendar:primary:evt-1",
  externalId: "evt-1",
  agentId: "agent-1",
  provider: "eliza",
  side: "owner",
  calendarId: "primary",
  title: "Gym session",
  description: "",
  location: "",
  status: "confirmed",
  startAt: "2026-09-08T14:00:00.000Z",
  endAt: "2026-09-08T15:00:00.000Z",
  isAllDay: false,
  timezone: "UTC",
  htmlLink: null,
  conferenceLink: null,
  organizer: null,
  attendees: [],
  metadata: {},
  syncedAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  grantId: "eliza-calendar",
};

function stubService() {
  return {
    getCalendarFeed: vi.fn(async () => ({
      calendarId: "all",
      events: [EVENT],
      source: "cache" as const,
      state: "complete" as const,
      sources: [{ status: "fresh" as const }],
      timeMin: "2026-09-01T00:00:00.000Z",
      timeMax: "2026-09-30T00:00:00.000Z",
      syncedAt: null,
    })),
  };
}

function fakeRuntime(service: ReturnType<typeof stubService>): IAgentRuntime {
  return {
    agentId: "agent-1",
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    reportError: () => undefined,
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

function spiedDeps() {
  const runTextModel = vi.fn(async () => null);
  const runJsonModel = vi.fn(async () => null);
  const recentConversationTexts = vi.fn(async () => [
    "whats on my calendar tuesday?",
  ]);
  const deps: CalendarActionDeps = {
    runTextModel,
    runJsonModel,
    recentConversationTexts,
  };
  return { deps, runTextModel, runJsonModel, recentConversationTexts };
}

async function runSearch(parameters: Record<string, unknown>) {
  const service = stubService();
  const spies = spiedDeps();
  const action = createCalendarActionRunner(spies.deps);
  const result = await action.handler(
    fakeRuntime(service),
    message("whats on my calendar tuesday?"),
    undefined,
    { parameters },
    vi.fn(async () => []),
  );
  if (!result) throw new Error("Expected a Calendar action result");
  return { result, ...spies, service };
}

describe("CALENDAR search_events call shape", () => {
  it.each([
    { query: "gym" },
    { queries: ["gym"] },
    { details: { query: "gym" } },
    { details: { queries: ["gym"] } },
  ])(
    "reads with a supported query alias without inference: %j",
    async (parameters) => {
      const { result, runTextModel, runJsonModel, recentConversationTexts } =
        await runSearch({ subaction: "search_events", ...parameters });
      expect(result.success).toBe(true);
      expect(runJsonModel).not.toHaveBeenCalled();
      expect(runTextModel).not.toHaveBeenCalled();
      expect(recentConversationTexts).not.toHaveBeenCalled();
    },
  );

  it("reads an unfiltered date range through feed without query extraction", async () => {
    const {
      result,
      runTextModel,
      runJsonModel,
      recentConversationTexts,
      service,
    } = await runSearch({
      subaction: "feed",
      details: {
        timeMin: "2026-09-16T00:00:00",
        timeMax: "2026-09-17T00:00:00",
        timeZone: "UTC",
      },
    });
    expect(result.success).toBe(true);
    expect(service.getCalendarFeed).toHaveBeenCalledTimes(1);
    expect(runJsonModel).not.toHaveBeenCalled();
    expect(runTextModel).not.toHaveBeenCalled();
    expect(recentConversationTexts).not.toHaveBeenCalled();
  });

  it.each([undefined, "event", "events", "calendar"])(
    "rejects a typed search without a content filter before inference or reading: %s",
    async (query) => {
      const {
        result,
        runTextModel,
        runJsonModel,
        recentConversationTexts,
        service,
      } = await runSearch({
        subaction: "search_events",
        query,
        details: {
          timeMin: "2026-09-16T00:00:00",
          timeMax: "2026-09-17T00:00:00",
          timeZone: "UTC",
        },
      });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).toContain(
        "CALENDAR_SEARCH_QUERY_REQUIRED",
      );
      expect(JSON.stringify(result)).toContain("feed");
      expect(runJsonModel).not.toHaveBeenCalled();
      expect(runTextModel).not.toHaveBeenCalled();
      expect(recentConversationTexts).not.toHaveBeenCalled();
      expect(service.getCalendarFeed).not.toHaveBeenCalled();
    },
  );
});

describe("Calendar repair completion", () => {
  it("reuses the verified answer after repairing a rejected search and releasing pending scope", async () => {
    const service = stubService();
    const spies = spiedDeps();
    const action = createCalendarActionRunner(spies.deps);
    const runtime = fakeRuntime(service);
    const actor = message(
      "How many calendar events are in the requested window? Do not change records.",
    );
    const details = {
      timeMin: "2026-09-01T00:00:00Z",
      timeMax: "2026-09-30T00:00:00Z",
      timeZone: "UTC",
    };
    const plans = [
      {
        name: "CALENDAR",
        arguments: {
          subaction: "search_events",
          query: "event",
          details,
          eliza_turn_scope: "more_work_pending",
        },
      },
      {
        name: "CALENDAR",
        arguments: {
          subaction: "feed",
          details,
          eliza_turn_scope: "more_work_pending",
        },
      },
      { name: "REPLY", arguments: { eliza_turn_scope: "final" } },
    ];
    const reply = "You have one calendar event in that window.";
    let planningCalls = 0;
    let evaluations = 0;
    const result = await runPlannerLoop({
      runtime: {
        useModel: async (type) => {
          if (type === "ACTION_PLANNER") {
            const plan = plans[planningCalls++];
            if (!plan)
              throw new Error(
                "Unexpected planner or failure-synthesis call after verified completion",
              );
            return {
              text: "",
              toolCalls: [{ id: `plan-${planningCalls}`, ...plan }],
            };
          }
          if (type === "RESPONSE_HANDLER" && ++evaluations <= 2)
            return JSON.stringify({
              thought:
                evaluations === 1
                  ? "The query was rejected before reading; use the unfiltered feed."
                  : "The complete feed contains one event; no requested operation remains.",
              success: evaluations === 2,
              decision: evaluations === 2 ? "FINISH" : "CONTINUE",
              ...(evaluations === 2 ? { messageToUser: reply } : {}),
            });
          throw new Error("Unexpected extra completion evaluation");
        },
      },
      context: {
        id: "calendar-query-repair",
        events: [
          {
            id: "request",
            type: "message",
            source: "user",
            createdAt: 1,
            content: actor.content.text ?? "",
          },
        ],
      },
      tools: [
        {
          name: "CALENDAR",
          description: "Read calendar events",
          parameters: { type: "object", properties: {} },
        },
      ],
      config: { maxIterations: 5, maxToolCalls: 3 },
      executeToolCall: async (call) =>
        actionResultToPlannerToolResult(
          await executePlannedToolCall(
            runtime,
            {
              message: actor,
              userRoles: ["OWNER"],
              activeContexts: ["calendar"],
              callback: async () => [],
            },
            { name: action.name, params: call.params ?? {} },
            { actions: [action] },
          ),
        ),
    });
    expect(result.finalMessage).toBe(reply);
    expect(planningCalls).toBe(3);
    expect(evaluations).toBe(2);
    expect(service.getCalendarFeed).toHaveBeenCalledTimes(1);
    expect(spies.runJsonModel).not.toHaveBeenCalled();
    expect(spies.runTextModel).not.toHaveBeenCalled();
    expect(
      result.trajectory.steps
        .filter((step) => step.result)
        .map((step) => step.result?.success),
    ).toEqual([false, true]);
    expect(
      result.trajectory.steps.find((step) => step.result?.success === false)
        ?.result,
    ).toMatchObject({
      turnComplete: false,
      effectReceipts: [
        expect.objectContaining({
          outcome: "failed",
          failure: expect.objectContaining({
            code: "CALENDAR_SEARCH_QUERY_REQUIRED",
            acceptance: "rejected",
          }),
        }),
      ],
    });
  });

  it.each([403, 500])(
    "keeps a real Calendar service failure authoritative: %s",
    async (status) => {
      const service = stubService();
      service.getCalendarFeed.mockImplementation(async () => {
        throw new CalendarServiceError(
          status,
          "Calendar service unavailable",
          "CALENDAR_READ_FAILED",
        );
      });
      const action = createCalendarActionRunner(spiedDeps().deps);
      const result = await action.handler(
        fakeRuntime(service),
        message("Read my calendar"),
        undefined,
        { parameters: { subaction: "feed" } },
        async () => [],
      );
      expect(result).toMatchObject({
        success: false,
        turnComplete: false,
        effectReceipts: [
          expect.objectContaining({
            outcome: "failed",
            failure: expect.objectContaining({ code: "CALENDAR_READ_FAILED" }),
          }),
        ],
      });
      expect(result?.data?.coachingFailure).not.toBe(true);
      expect(service.getCalendarFeed).toHaveBeenCalledTimes(1);
    },
  );
});
