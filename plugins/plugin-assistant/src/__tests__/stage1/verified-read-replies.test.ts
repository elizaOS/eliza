import type { Action } from "@elizaos/core/protocol";
import { ModelType, type UUID } from "@elizaos/core/protocol";
import { describe, expect, it, vi } from "vitest";
import { runV5MessageRuntimeStage1 } from "../../services/message.js";
import {
  makeMessage,
  makeRuntime,
  makeState,
  runStage1,
  stage1Response,
  useModelCalls,
} from "./fixtures.js";

// A read action that already spoke to the user must be the turn's single final
// message. Live incident: a calendar read's callback posted "clear tomorrow.",
// then the evaluator — unaware of the delivery — authored "you're clear
// tomorrow.", a semantic paraphrase the byte-level dedupe correctly refuses to
// touch, so one question produced two bubbles. The structural contract under
// test: a verified callback-delivered answer declares `turnComplete`, the
// gated evaluator path skips the paraphrase-capable model call entirely, and
// the provenance suppression drops the byte-equal finalMessage as already
// delivered. Side-effect turns without a verified answer keep their model
// reply, and byte-identical echoes stay deduped without `turnComplete`.
describe("verified read actions own the turn's single user-facing message", () => {
  const CALENDAR_ANSWER = "clear tomorrow.";
  const CLOUD_EMPTY_ANSWER =
    "You don't have any agents hosted on Eliza Cloud yet. You can provision one from the Cloud console, or ask me to create one.";

  function makeCalendarReadAction(handler: Action["handler"]): Action {
    return {
      name: "CALENDAR",
      similes: [],
      tags: ["domain:calendar", "capability:read"],
      description: "Read the owner's live calendar.",
      contexts: ["calendar"],
      suppressPostActionContinuation: true,
      parameters: [
        {
          name: "intent",
          description: "Natural-language calendar request.",
          schema: { type: "string" },
        },
      ],
      validate: async () => true,
      handler,
    } as Action;
  }

  function calendarPlannerResponses(): unknown[] {
    return [
      stage1Response({
        contexts: ["calendar"],
        candidateActionNames: ["CALENDAR"],
        replyText: "",
        extra: { requiresTool: true },
      }),
      {
        thought: "Read tomorrow's calendar.",
        toolCalls: [
          {
            id: "calendar-1",
            name: "CALENDAR",
            arguments: { intent: "whats on my calendar tomorrow" },
          },
        ],
      },
    ];
  }

  it("executes the planner-selected Calendar action while keeping authorized distractors available", async () => {
    const runtime = makeRuntime(calendarPlannerResponses());
    const calendarHandler = vi.fn(
      async (_runtime, _message, _state, options) => {
        expect(options.parameters).toMatchObject({
          intent: "whats on my calendar tomorrow",
        });
        return {
          success: true,
          text: CALENDAR_ANSWER,
          userFacingText: CALENDAR_ANSWER,
          verifiedUserFacing: true,
          turnComplete: true,
        };
      },
    );
    const distractorHandler = vi.fn(async () => {
      throw new Error("The planner did not select this action.");
    });
    const distractor = (name: string): Action =>
      ({
        name,
        similes: [],
        tags: ["domain:calendar"],
        description: `${name} distractor sharing calendar schedule week event keywords.`,
        contexts: ["calendar"],
        parameters: [],
        validate: async () => true,
        handler: distractorHandler,
      }) as Action;
    runtime.actions = [
      makeCalendarReadAction(calendarHandler),
      distractor("SCHEDULED_HOUSEHOLD_DISTRACTOR"),
      distractor("WEEKLY_BRIEF_DISTRACTOR"),
    ] as never;

    const result = await runStage1({
      runtime,
      message: makeMessage({ text: "whats on my calendar tomorrow" }),
      responseId: "00000000-0000-0000-0000-000000000021" as UUID,
    });

    const calls = useModelCalls(runtime);
    expect(calls.map((call) => call[0])).toEqual([
      ModelType.RESPONSE_HANDLER,
      ModelType.ACTION_PLANNER,
    ]);
    expect(calendarHandler).toHaveBeenCalledTimes(1);
    expect(distractorHandler).not.toHaveBeenCalled();
    // Stage-1 selects the native family; every other authorized family stays
    // advertised by discovery and no distractor executes without a tool call.
    const plannerParams = calls[1]?.[1] as {
      tools?: Array<{ name: string; description?: string }>;
    };
    expect(plannerParams.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["CALENDAR", "DISCOVER_ACTIONS"]),
    );
    const discovery = plannerParams.tools?.find(
      (tool) => tool.name === "DISCOVER_ACTIONS",
    )?.description;
    expect(discovery).toContain("Find authorized operations");
    expect(discovery).not.toContain("WEEKLY_BRIEF_DISTRACTOR");
    expect(result.kind).toBe("planned_reply");
    expect(result.messageHandler.plan.deterministicToolCall).toBeUndefined();
    if (result.kind === "planned_reply") {
      expect(result.result.responseContent?.text).toBe(CALENDAR_ANSWER);
    }
  });

  it("delivers a turnComplete verified read answer exactly once with no model paraphrase", async () => {
    const runtime = makeRuntime(calendarPlannerResponses());
    const calendarHandler = vi.fn(
      async (_runtime, _message, _state, _options, callback) => {
        await callback?.({
          text: CALENDAR_ANSWER,
          source: "action",
          action: "CALENDAR",
        });
        return {
          success: true,
          text: CALENDAR_ANSWER,
          userFacingText: CALENDAR_ANSWER,
          verifiedUserFacing: true,
          turnComplete: true,
        };
      },
    );
    runtime.actions = [makeCalendarReadAction(calendarHandler)] as never;
    const deliveredVisibleTexts = new Set<string>();
    const delivered: string[] = [];

    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({ text: "whats on my calendar tomorrow" }),
      state: makeState(),
      responseId: "00000000-0000-0000-0000-000000000005" as UUID,
      deliveredVisibleTexts,
      callback: async (content) => {
        if (content.text) {
          delivered.push(content.text);
          deliveredVisibleTexts.add(content.text.toLowerCase());
        }
        return [];
      },
    });

    expect(calendarHandler).toHaveBeenCalledTimes(1);
    // The action's own delivery is the turn's only user-facing message.
    expect(delivered).toEqual([]);
    // The gated evaluator skips the paraphrase-capable model call outright:
    // Stage 1 + planner only, no in-loop evaluator call remains queued.
    expect(useModelCalls(runtime).map((call) => call[0])).toEqual([
      ModelType.RESPONSE_HANDLER,
      ModelType.ACTION_PLANNER,
    ]);
    expect(result.kind).toBe("planned_reply");
    if (result.kind === "planned_reply") {
      expect(result.result.responseContent?.text).toBe(CALENDAR_ANSWER);
      expect(result.result.responseMessages).toHaveLength(1);
    }
  });

  it("delivers the CLOUD_LIST_AGENTS zero-agent answer exactly once with no evaluator call", async () => {
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["cloud", "settings"],
        candidateActionNames: ["CLOUD_LIST_AGENTS"],
        replyText: "",
        extra: { requiresTool: true },
      }),
      {
        thought: "Read the owner's hosted agent inventory.",
        toolCalls: [
          {
            id: "cloud-list-agents-1",
            name: "CLOUD_LIST_AGENTS",
            arguments: {},
          },
        ],
      },
    ]);
    const cloudListHandler = vi.fn(
      async (_runtime, _message, _state, _options, callback) => {
        await callback?.({
          text: CLOUD_EMPTY_ANSWER,
          source: "action",
          action: "CLOUD_LIST_AGENTS",
        });
        return {
          success: true,
          text: "User has no hosted Eliza Cloud agents.",
          userFacingText: CLOUD_EMPTY_ANSWER,
          verifiedUserFacing: true,
          turnComplete: true,
          data: { count: 0, agents: [] },
        };
      },
    );
    runtime.actions = [
      {
        name: "CLOUD_LIST_AGENTS",
        similes: ["MY_CLOUD_AGENTS"],
        tags: ["domain:cloud", "capability:read"],
        description: "List the owner's hosted Eliza Cloud agents.",
        contexts: ["cloud", "settings"],
        suppressPostActionContinuation: true,
        validate: async () => true,
        handler: cloudListHandler,
      } as Action,
    ] as never;
    const deliveredVisibleTexts = new Set<string>();
    const delivered: string[] = [];

    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({ text: "what cloud agents do I have?" }),
      state: makeState(),
      responseId: "00000000-0000-0000-0000-000000000005" as UUID,
      deliveredVisibleTexts,
      callback: async (content) => {
        if (content.text) {
          delivered.push(content.text);
          deliveredVisibleTexts.add(content.text.toLowerCase());
        }
        return [];
      },
    });

    expect(cloudListHandler).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual([]);
    expect(useModelCalls(runtime).map((call) => call[0])).toEqual([
      ModelType.RESPONSE_HANDLER,
      ModelType.ACTION_PLANNER,
    ]);
    expect(result.kind).toBe("planned_reply");
    if (result.kind === "planned_reply") {
      expect(result.result.responseContent?.text).toBe(CLOUD_EMPTY_ANSWER);
      expect(result.result.responseMessages).toHaveLength(1);
    }
  });

  it("keeps the model reply for a side-effect action without a verified answer", async () => {
    const modelReply = "Sunny out — nothing to reschedule.";
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["general"],
        candidateActionNames: ["WEB_SEARCH"],
        replyText: "",
        extra: { requiresTool: true },
      }),
      {
        thought: "Check the demo weather.",
        toolCalls: [
          {
            id: "search-1",
            name: "WEB_SEARCH",
            arguments: { query: "demo weather" },
          },
        ],
      },
      JSON.stringify({
        success: true,
        decision: "FINISH",
        thought: "Summarize the result.",
        messageToUser: modelReply,
      }),
    ]);
    runtime.actions = [
      {
        name: "WEB_SEARCH",
        similes: [],
        tags: ["resource:web", "capability:read"],
        description: "Read current public information.",
        contexts: ["general", "web"],
        parameters: [
          {
            name: "query",
            description: "Search query",
            required: true,
            schema: { type: "string" },
          },
        ],
        validate: async () => true,
        handler: async () => ({
          success: true,
          text: "Sunny.",
          data: { query: "demo weather" },
        }),
      },
    ] as never;

    const result = await runStage1({
      runtime,
      message: makeMessage({ text: "Search for the demo weather." }),
    });

    // No verified user-facing answer was delivered by the action, so the
    // evaluator still runs and its reply still ships.
    expect(useModelCalls(runtime).map((call) => call[0])).toEqual([
      ModelType.RESPONSE_HANDLER,
      ModelType.ACTION_PLANNER,
      ModelType.RESPONSE_HANDLER,
    ]);
    expect(result.kind).toBe("planned_reply");
    if (result.kind === "planned_reply") {
      expect(result.result.responseContent?.text).toBe(modelReply);
    }
  });

  it("still dedupes a byte-identical model echo of a delivered answer without turnComplete", async () => {
    const runtime = makeRuntime([
      ...calendarPlannerResponses(),
      JSON.stringify({
        success: true,
        decision: "FINISH",
        thought: "Relay the calendar answer.",
        messageToUser: CALENDAR_ANSWER,
      }),
    ]);
    const calendarHandler = vi.fn(
      async (_runtime, _message, _state, _options, callback) => {
        await callback?.({
          text: CALENDAR_ANSWER,
          source: "action",
          action: "CALENDAR",
        });
        return {
          success: true,
          text: CALENDAR_ANSWER,
          userFacingText: CALENDAR_ANSWER,
          verifiedUserFacing: true,
        };
      },
    );
    runtime.actions = [makeCalendarReadAction(calendarHandler)] as never;
    const deliveredVisibleTexts = new Set<string>();
    const delivered: string[] = [];

    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({ text: "whats on my calendar tomorrow" }),
      state: makeState(),
      responseId: "00000000-0000-0000-0000-000000000005" as UUID,
      deliveredVisibleTexts,
      callback: async (content) => {
        if (content.text) {
          delivered.push(content.text);
          deliveredVisibleTexts.add(content.text.toLowerCase());
        }
        return [];
      },
    });

    // Without turnComplete the evaluator runs; the held callback and its
    // byte-identical evaluator text produce one final response.
    expect(useModelCalls(runtime).map((call) => call[0])).toEqual([
      ModelType.RESPONSE_HANDLER,
      ModelType.ACTION_PLANNER,
      ModelType.RESPONSE_HANDLER,
    ]);
    expect(delivered).toEqual([]);
    expect(result.kind).toBe("planned_reply");
    if (result.kind === "planned_reply") {
      expect(result.result.responseContent?.text).toBe(CALENDAR_ANSWER);
      expect(result.result.responseMessages).toHaveLength(1);
    }
  });

  const CALENDAR_FAILURE = "calendar's acting up. couldn't pull your week.";

  it("delivers a turnComplete verified FAILURE exactly once with no model paraphrase", async () => {
    const runtime = makeRuntime(calendarPlannerResponses());
    const calendarHandler = vi.fn(
      async (_runtime, _message, _state, _options, callback) => {
        await callback?.({
          text: CALENDAR_FAILURE,
          source: "action",
          action: "CALENDAR",
        });
        return {
          success: false,
          text: CALENDAR_FAILURE,
          userFacingText: CALENDAR_FAILURE,
          verifiedUserFacing: true,
          turnComplete: true,
        };
      },
    );
    runtime.actions = [makeCalendarReadAction(calendarHandler)] as never;
    const deliveredVisibleTexts = new Set<string>();
    const delivered: string[] = [];

    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({ text: "whats on my calendar tomorrow" }),
      state: makeState(),
      responseId: "00000000-0000-0000-0000-000000000005" as UUID,
      deliveredVisibleTexts,
      callback: async (content) => {
        if (content.text) {
          delivered.push(content.text);
          deliveredVisibleTexts.add(content.text.toLowerCase());
        }
        return [];
      },
    });

    expect(calendarHandler).toHaveBeenCalledTimes(1);
    // The action's held failure text becomes the turn's only user-facing
    // message — no "I couldn't verify... want me to try again?" paraphrase
    // bubble follows it (live incident on the failed-read path).
    expect(delivered).toEqual([]);
    // The verified-failure gate skips the paraphrase-capable evaluator call.
    expect(useModelCalls(runtime).map((call) => call[0])).toEqual([
      ModelType.RESPONSE_HANDLER,
      ModelType.ACTION_PLANNER,
    ]);
    expect(result.kind).toBe("planned_reply");
    if (result.kind === "planned_reply") {
      expect(result.result.responseContent?.text).toBe(CALENDAR_FAILURE);
      expect(result.result.responseMessages).toHaveLength(1);
    }
  });

  it("keeps the evaluator's additive follow-up for a failure without turnComplete", async () => {
    const recovery = "That read failed — want me to reconnect your calendar?";
    const runtime = makeRuntime([
      ...calendarPlannerResponses(),
      JSON.stringify({
        success: false,
        decision: "FINISH",
        thought: "Offer recovery.",
        messageToUser: recovery,
      }),
    ]);
    const calendarHandler = vi.fn(
      async (_runtime, _message, _state, _options, callback) => {
        await callback?.({
          text: CALENDAR_FAILURE,
          source: "action",
          action: "CALENDAR",
        });
        return {
          success: false,
          text: CALENDAR_FAILURE,
          userFacingText: CALENDAR_FAILURE,
          verifiedUserFacing: true,
        };
      },
    );
    runtime.actions = [makeCalendarReadAction(calendarHandler)] as never;
    const deliveredVisibleTexts = new Set<string>();
    const delivered: string[] = [];

    await runStage1({
      runtime,
      message: makeMessage({ text: "whats on my calendar tomorrow" }),
      deliveredVisibleTexts,
      callback: async (content) => {
        if (content.text) {
          delivered.push(content.text);
          deliveredVisibleTexts.add(content.text.toLowerCase());
        }
        return [];
      },
    });

    // Without the turnComplete stamp the failure stays un-gated: the
    // evaluator still runs, so a site that WANTS additive recovery guidance
    // keeps it by simply not stamping its failure result.
    expect(useModelCalls(runtime).map((call) => call[0])).toEqual([
      ModelType.RESPONSE_HANDLER,
      ModelType.ACTION_PLANNER,
      ModelType.RESPONSE_HANDLER,
    ]);
  });
});
