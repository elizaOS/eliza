/**
 * On a short conversation the planner's action source review cost more than
 * the transcript it could defer, and its per-turn source identity made every
 * domain tool definition differ from the previous turn's. Where no post-turn
 * review runs, the review also came and went as the transcript grew, a review
 * was accepted or the positional window applied, and took the definitions
 * with it each time.
 */
import {
  ChannelType,
  type ContextEvent,
  type ContextObject,
  completionContextSources,
  type Memory,
  type ToolDefinition,
  type TrajectoryRecorder,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeMessage,
  makeRuntime,
  makeState,
} from "../../__tests__/stage1/fixtures.ts";
import { createV5MessageContextObject } from "../../services/message/context-assembly.ts";
import {
  projectBackgroundHistory,
  projectReviewedHistory,
  withBackgroundHistory,
} from "../../services/message/history-discovery.ts";
import {
  applyHistoryRetentionReview,
  prepareHistoryRetention,
  windowHistoryRetention,
} from "../history-retention.ts";
import { ACTION_CONTEXT_ARG, runPlannerLoop } from "../planner-loop.ts";

// A host that reviews after the turn, whatever the machine running the tests
// is; the phone cases override it.
beforeEach(() => vi.stubEnv("ELIZA_PLATFORM", ""));
afterEach(() => vi.unstubAllEnvs());

const CREATE: ToolDefinition = {
  name: "CALENDAR_CREATE_EVENT",
  description: "Create a calendar event.",
  parameters: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
};

function dialogue(count: number, text: (index: number) => string) {
  return Array.from({ length: count }, (_, index) => ({
    id: `history:${index}`,
    type: "segment" as const,
    source: "prior-dialogue",
    segment: {
      id: `history:${index}`,
      label: index % 2 ? "prior_message:agent" : "prior_message:user",
      content: text(index),
      stable: false,
    },
  }));
}

/** One planner turn in the room: the prior dialogue, then the new request. */
function turn(messageId: string, events: ContextEvent[]): ContextObject {
  return {
    id: messageId,
    metadata: { roomId: "room", messageId },
    events: [
      ...events,
      {
        id: `${messageId}:request`,
        type: "message",
        message: {
          id: `${messageId}:request`,
          role: "user",
          content: "Add lunch with Sam on Friday.",
        },
      },
    ],
  };
}

type PlannerRequest = {
  tools: ToolDefinition[];
  system: string;
  input: string;
};

function plannerRequest(params: Record<string, unknown>): PlannerRequest {
  const messages = params.messages as Array<{ role: string }>;
  return {
    tools: params.tools as ToolDefinition[],
    system: JSON.stringify(
      messages.filter((message) => message.role === "system"),
    ),
    input: JSON.stringify(messages),
  };
}

/** The first planner request of a turn that replies at once. */
async function firstPlannerRequest(
  context: ContextObject,
  tools: ToolDefinition[] = [CREATE],
) {
  const requests: PlannerRequest[] = [];
  await runPlannerLoop({
    runtime: {
      useModel: async (_type: unknown, params: Record<string, unknown>) => {
        requests.push(plannerRequest(params));
        return {
          text: "",
          toolCalls: [
            {
              id: "reply",
              name: "REPLY",
              arguments: { text: "Added.", eliza_turn_scope: "final" },
            },
          ],
        };
      },
    },
    context,
    tools,
    executeToolCall: async () => ({ success: true, text: "Created." }),
    evaluate: async () => ({
      success: true,
      decision: "FINISH",
      thought: "Replied.",
      messageToUser: "Added.",
    }),
  });
  expect(requests).toHaveLength(1);
  return requests[0];
}

/** A turn whose first planner call creates the event with a complete review
 * that selects only the first original, and whose second call replies. */
async function reviewedTurn(
  context: ContextObject,
  sourceSetId: string,
  /** Runs while the first planner call is awaited. */
  whileAwaited?: () => void,
) {
  const requests: PlannerRequest[] = [];
  const executed: Array<{ completionContext?: unknown }> = [];
  const attributions: unknown[] = [];
  const recorder: TrajectoryRecorder = {
    startTrajectory: () => "reviewed-turn",
    recordStage: async (_id, stage) => {
      if (stage.kind !== "planner") return;
      const options = stage.model?.providerOptions as
        | { eliza?: { plannerSourceSelection?: unknown } }
        | undefined;
      attributions.push(options?.eliza?.plannerSourceSelection);
    },
    endTrajectory: async () => {},
    load: async () => null,
    list: async () => [],
  };
  const result = await runPlannerLoop({
    runtime: {
      useModel: async (_type: unknown, params: Record<string, unknown>) => {
        requests.push(plannerRequest(params));
        if (requests.length === 1) whileAwaited?.();
        return {
          text: "",
          toolCalls:
            requests.length === 1
              ? [
                  {
                    id: "create",
                    name: CREATE.name,
                    arguments: {
                      title: "Lunch with Sam",
                      eliza_turn_scope: "more_work_pending",
                      [ACTION_CONTEXT_ARG]: {
                        mode: "relevant_prior_dialogue",
                        sourceSetId,
                        complete: true,
                        relevantSourceIds: ["h1"],
                        constraintSourceIds: [],
                        referentSourceIds: [],
                        pendingIntentSourceIds: [],
                      },
                    },
                  },
                ]
              : [
                  {
                    id: "reply",
                    name: "REPLY",
                    arguments: { text: "Added.", eliza_turn_scope: "final" },
                  },
                ],
        };
      },
    },
    context,
    tools: [CREATE],
    executeToolCall: async (call) => {
      executed.push(call);
      return { success: true, text: "Created." };
    },
    evaluate: async () => ({
      success: false,
      decision: "CONTINUE",
      thought: "The created event still needs a reply.",
    }),
    recorder,
    trajectoryId: "reviewed-turn",
  });
  expect(requests).toHaveLength(2);
  expect(executed).toHaveLength(1);
  return {
    first: requests[0],
    second: requests[1],
    executed: executed[0],
    stored: result.trajectory.modelBaseContext?.metadata?.completionContext,
    /** How the first planner call's review was recorded. */
    attribution: attributions[0],
  };
}

/** A turn whose first planner call creates the event without a review, and
 * whose second call replies. */
async function unreviewedTurn(context: ContextObject) {
  const requests: PlannerRequest[] = [];
  const result = await runPlannerLoop({
    runtime: {
      useModel: async (_type: unknown, params: Record<string, unknown>) => {
        requests.push(plannerRequest(params));
        return {
          text: "",
          toolCalls:
            requests.length === 1
              ? [
                  {
                    id: "create",
                    name: CREATE.name,
                    arguments: {
                      title: "Lunch with Sam",
                      eliza_turn_scope: "more_work_pending",
                    },
                  },
                ]
              : [
                  {
                    id: "reply",
                    name: "REPLY",
                    arguments: { text: "Added.", eliza_turn_scope: "final" },
                  },
                ],
        };
      },
    },
    context,
    tools: [CREATE],
    executeToolCall: async () => ({ success: true, text: "Created." }),
    evaluate: async () => ({
      success: false,
      decision: "CONTINUE",
      thought: "The created event still needs a reply.",
    }),
  });
  expect(requests).toHaveLength(2);
  return {
    first: requests[0],
    second: requests[1],
    stored: result.trajectory.modelBaseContext?.metadata?.completionContext,
  };
}

/** A turn as the message service assembles it from a stored message and the
 * thirty long messages before it. */
function assembledTurn(channelType: ChannelType): Promise<ContextObject> {
  const runtime = makeRuntime([]);
  const message = makeMessage({
    channelType,
    text: "Add lunch with Sam on Friday.",
  });
  message.createdAt = 1000;
  const state = makeState();
  state.data.providers = {
    RECENT_MESSAGES: {
      data: {
        recentMessages: Array.from(
          { length: 30 },
          (_, index): Memory => ({
            ...message,
            id: `00000000-0000-0000-0000-${String(100 + index).padStart(12, "0")}` as Memory["id"],
            createdAt: index + 1,
            entityId: index % 2 ? runtime.agentId : message.entityId,
            content: { ...message.content, text: LONG(index) },
          }),
        ),
      },
    },
  };
  return createV5MessageContextObject({ runtime, message, state });
}

/** The turn as Stage 1 hands it over where no post-turn review runs: earlier
 * originals deferred by position. */
function windowedTurn(context: ContextObject): ContextObject {
  const scope = {
    agentId: "agent",
    roomId: "room",
    entityId: "owner",
    roles: ["OWNER"],
  };
  const window = windowHistoryRetention(context, scope, null);
  const history = projectReviewedHistory(context, scope, window.checkpoint);
  if (!history || !window.windowed) throw new Error("Missing window");
  history.windowed = true;
  return withBackgroundHistory(context, history);
}

const SHORT = (index: number) => `short exchange ${index}.`;
const LONG = (index: number) =>
  `long exchange ${index}: ${"detail ".repeat(40)}`;

describe("planner action source review break-even", () => {
  it("withholds the review on a short transcript and keeps tool definitions identical across turns", async () => {
    const first = await firstPlannerRequest(turn("turn-1", dialogue(4, SHORT)));
    const second = await firstPlannerRequest(
      turn("turn-2", dialogue(6, SHORT)),
    );
    for (const request of [first, second]) {
      expect(JSON.stringify(request.tools)).not.toContain(ACTION_CONTEXT_ARG);
      expect(request.input).not.toContain("action_source_review");
      expect(request.input).not.toContain(
        "Completion-context field instructions",
      );
      expect(request.input).toContain("short exchange 3.");
    }
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
  });

  it("still offers the review on a long transcript and keeps tool definitions identical across turns", async () => {
    const contexts = [
      turn("turn-1", dialogue(30, LONG)),
      turn("turn-2", dialogue(32, LONG)),
    ];
    const first = await firstPlannerRequest(contexts[0]);
    const second = await firstPlannerRequest(contexts[1]);
    for (const [index, request] of [first, second].entries()) {
      const create = request.tools.find((tool) => tool.name === CREATE.name);
      expect(create?.parameters?.required).toContain(ACTION_CONTEXT_ARG);
      // The schema names the request, never the turn's own source identity.
      expect(
        create?.parameters?.properties?.[ACTION_CONTEXT_ARG]?.properties
          ?.sourceSetId?.enum,
      ).toEqual(["current_request"]);
      expect(JSON.stringify(request.tools)).not.toMatch(/[0-9a-f]{64}/);
      expect(JSON.stringify(request.tools) + request.input).not.toContain(
        completionContextSources(contexts[index]).sourceSetId,
      );
      expect(request.input).toContain("action_source_review");
      expect(request.system).toContain("Completion-context field instructions");
      expect(request.input).toContain(`[h${30 + 2 * index}]`);
    }
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(second.system).toBe(first.system);
  });

  it("counts the schema each reviewing tool would carry", async () => {
    // About 5,000 characters of dialogue: more than a review costs with one
    // domain tool, less than it costs once six tools each carry its schema.
    const events = dialogue(
      25,
      (index) => `exchange ${index}: ${"x".repeat(180)}`,
    );
    const one = await firstPlannerRequest(turn("turn-1", events));
    expect(JSON.stringify(one.tools)).toContain(ACTION_CONTEXT_ARG);

    const six = await firstPlannerRequest(
      turn("turn-1", events),
      Array.from({ length: 6 }, (_, index) => ({
        ...CREATE,
        name: `${CREATE.name}_${index}`,
      })),
    );
    expect(JSON.stringify(six.tools)).not.toContain(ACTION_CONTEXT_ARG);
    expect(six.input).not.toContain("action_source_review");
  });

  it("counts only the historical receipts a review could defer with their request", async () => {
    const receipt = (requestSourceEventId: string): ContextEvent => {
      const content = JSON.stringify({
        requestSourceEventId,
        navigation: [{ success: true, receipt: "opened ".repeat(900) }],
      });
      return {
        id: "receipt",
        type: "segment",
        source: "message-service",
        segment: {
          id: "receipt",
          label: "runtime:historical_navigation",
          content,
          stable: false,
        },
      };
    };
    const bound = await firstPlannerRequest(
      turn("turn-1", [...dialogue(4, SHORT), receipt("history:0")]),
    );
    expect(JSON.stringify(bound.tools)).toContain(ACTION_CONTEXT_ARG);

    // A receipt whose request is not a reviewable original stays inline
    // whatever the review selects, so it cannot pay for one.
    const unbound = await firstPlannerRequest(
      turn("turn-1", [...dialogue(4, SHORT), receipt("history:unknown")]),
    );
    expect(JSON.stringify(unbound.tools)).not.toContain(ACTION_CONTEXT_ARG);
  });

  it("keeps an explicit earlier selection in force when the review is withheld", async () => {
    const context = turn("turn", dialogue(30, SHORT));
    const scope = {
      agentId: "agent",
      roomId: "room",
      entityId: "owner",
      roles: ["OWNER"],
    };
    const prepared = prepareHistoryRetention(
      context,
      scope,
      null,
      "evidence",
      30,
    );
    const checkpoint = applyHistoryRetentionReview(prepared, {
      sourceSetId: prepared.sourceSetId,
      complete: true,
      retainSourceIds: [],
      deferSourceIds: prepared.candidates.map((source) => source.id),
      uncertainSourceIds: [],
      dependencyGroups: [],
    });
    const history = projectReviewedHistory(context, scope, checkpoint);
    if (!history) throw new Error("Missing validated projection");
    // The reply handler asked for all prior dialogue, which overrides the
    // background view that would otherwise defer the early originals.
    const allPriorDialogue = {
      mode: "full",
      sourceSetId: completionContextSources(context).sourceSetId,
      complete: false,
      relevantSourceIds: [],
      constraintSourceIds: [],
      referentSourceIds: [],
      pendingIntentSourceIds: [],
    };
    const full = withBackgroundHistory(context, history);
    expect(
      JSON.stringify(projectBackgroundHistory(full).context.events),
    ).not.toContain("short exchange 2.");
    full.metadata = { ...full.metadata, completionContext: allPriorDialogue };

    const requests: Array<{ tools: ToolDefinition[]; input: string }> = [];
    const result = await runPlannerLoop({
      context: full,
      tools: [{ name: "READ", description: "Read a record" }],
      runtime: {
        useModel: async (_type: unknown, params: Record<string, unknown>) => {
          requests.push({
            tools: params.tools as ToolDefinition[],
            input: JSON.stringify(params.messages),
          });
          return {
            text: "",
            toolCalls:
              requests.length === 1
                ? [{ id: "read", name: "READ", arguments: {} }]
                : [
                    {
                      id: "reply",
                      name: "REPLY",
                      arguments: { text: "Done." },
                    },
                  ],
          };
        },
      },
      executeToolCall: async () => ({ success: true, text: "Read." }),
      evaluate: async () => ({
        success: false,
        decision: "CONTINUE",
        thought: "The read result still needs a reply.",
      }),
    });

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.input).not.toContain("action_source_review");
      expect(request.input).toContain("short exchange 2.");
      expect(JSON.stringify(request.tools)).not.toContain("RESTORE_CONTEXT");
    }
    expect(
      result.trajectory.modelBaseContext?.metadata?.completionContext,
    ).toEqual(allPriorDialogue);
  });
});

describe("planner action source review identity", () => {
  const selectedFirstOriginal = (sourceSetId: string) => ({
    mode: "selected",
    sourceSetId,
    complete: true,
    relevantSourceIds: ["h1"],
    constraintSourceIds: [],
    referentSourceIds: [],
    pendingIntentSourceIds: [],
  });

  it.each([
    ["the offered request reference", () => "current_request"],
    [
      "the originals' own identity",
      (context: ContextObject) => completionContextSources(context).sourceSetId,
    ],
  ])(
    "accepts a review that carries %s and stores it under the originals' identity",
    async (_name, submitted) => {
      const context = turn("turn-1", dialogue(30, LONG));
      const identity = completionContextSources(context).sourceSetId;
      const { second, executed, stored, attribution } = await reviewedTurn(
        context,
        submitted(context),
      );
      expect(stored).toEqual(selectedFirstOriginal(identity));
      expect(executed.completionContext).toEqual(
        selectedFirstOriginal(identity),
      );
      // The recorded offer and submission are the originals' identity as well.
      const recorded = attribution as Record<string, unknown>;
      expect(recorded).toMatchObject({
        reason: "accepted_selected",
        sourceSetMatches: true,
      });
      expect(recorded.currentSourceSetSHA256).toEqual(expect.any(String));
      for (const key of ["offered", "submitted", "accepted"])
        expect(recorded[`${key}SourceSetSHA256`]).toBe(
          recorded.currentSourceSetSHA256,
        );
      // The accepted review governs the rest of the turn.
      expect(second.input).toContain("long exchange 0:");
      expect(second.input).not.toContain("long exchange 20:");
      expect(second.input).not.toContain("action_source_review");
      expect(JSON.stringify(second.tools)).toContain("RESTORE_CONTEXT");
    },
  );

  it("refuses a review that carries another source set's identity", async () => {
    const context = turn("turn-1", dialogue(30, LONG));
    const { second, executed, stored, attribution } = await reviewedTurn(
      context,
      completionContextSources(turn("turn-2", dialogue(30, LONG))).sourceSetId,
    );
    expect(stored).toBeNull();
    expect(executed.completionContext).toBeNull();
    expect(attribution).toMatchObject({
      reason: "stale_source_set",
      sourceSetMatches: false,
    });
    expect(second.input).toContain("long exchange 20:");
    expect(JSON.stringify(second.tools)).not.toContain("RESTORE_CONTEXT");
  });

  it("binds the request reference to the originals the request was rendered from", async () => {
    const context = turn("turn-1", dialogue(30, LONG));
    // An original changes while the model is awaited: the reference stands
    // for what the model was shown, which is no longer the conversation.
    const { second, executed, stored } = await reviewedTurn(
      context,
      "current_request",
      () => {
        const original = context.events.find(
          (event) => event.type === "segment",
        ) as { segment: { content: string } };
        original.segment.content = "edited while the model was reading.";
      },
    );
    expect(stored).toBeNull();
    expect(executed.completionContext).toBeNull();
    expect(second.input).toContain("long exchange 20:");
  });

  it("refuses the request reference on a request that offered no review", async () => {
    const { first, second, executed, stored } = await reviewedTurn(
      turn("turn-1", dialogue(4, SHORT)),
      "current_request",
    );
    expect(JSON.stringify(first.tools)).not.toContain(ACTION_CONTEXT_ARG);
    expect(stored).toBeNull();
    expect(executed.completionContext).toBeNull();
    expect(second.input).toContain("short exchange 3.");
  });
});

// The transcripts here are long enough that a host which reviews its turns is
// offered the review on them, as the break-even tests above show.
describe("planner action source review where no post-turn review runs", () => {
  it("offers no review on a phone and keeps tool definitions identical across turns", async () => {
    vi.stubEnv("ELIZA_PLATFORM", "android");
    const first = await firstPlannerRequest(turn("turn-1", dialogue(30, LONG)));
    const second = await firstPlannerRequest(
      turn("turn-2", dialogue(32, LONG)),
    );
    for (const request of [first, second]) {
      expect(JSON.stringify(request.tools)).not.toContain(ACTION_CONTEXT_ARG);
      expect(request.input).not.toContain("action_source_review");
      expect(request.input).not.toContain(
        "Completion-context field instructions",
      );
      // Nothing is deferred in the review's place.
      expect(request.input).toContain("long exchange 0:");
      expect(request.input).toContain("long exchange 29:");
    }
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(second.system).toBe(first.system);
  });

  it("sends the same tool definitions on both requests of a phone turn", async () => {
    vi.stubEnv("ELIZA_PLATFORM", "android");
    const { first, second } = await unreviewedTurn(
      turn("turn-1", dialogue(30, LONG)),
    );
    expect(JSON.stringify(first.tools)).not.toContain(ACTION_CONTEXT_ARG);
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    for (const request of [first, second]) {
      expect(request.input).not.toContain("action_source_review");
      expect(request.input).toContain("long exchange 0:");
    }
    // The second request is the first with the tool call and its result
    // appended, so everything the first one sent can be reused.
    expect(second.input.startsWith(first.input.slice(0, -1))).toBe(true);
  });

  it("keeps a domain tool's definition once the positional window applies on a phone", async () => {
    vi.stubEnv("ELIZA_PLATFORM", "android");
    const before = await firstPlannerRequest(
      turn("turn-1", dialogue(30, LONG)),
    );
    const windowed = await firstPlannerRequest(
      windowedTurn(turn("turn-2", dialogue(44, LONG))),
    );
    expect(windowed.input).toContain("deferred by position");
    expect(windowed.input).not.toContain("long exchange 2:");
    // The history read is the one definition the window adds.
    expect(
      JSON.stringify(
        windowed.tools.filter((tool) => tool.name !== "RESTORE_CONTEXT"),
      ),
    ).toBe(JSON.stringify(before.tools));
  });

  it("keeps an explicit earlier selection in force on a phone", async () => {
    vi.stubEnv("ELIZA_PLATFORM", "android");
    const context = turn("turn", dialogue(44, LONG));
    const windowed = windowedTurn(context);
    expect(
      JSON.stringify(projectBackgroundHistory(windowed).context.events),
    ).not.toContain("long exchange 2:");
    // The reply handler asked for all prior dialogue, which overrides the
    // window that would otherwise defer the early originals.
    const allPriorDialogue = {
      mode: "full",
      sourceSetId: completionContextSources(context).sourceSetId,
      complete: false,
      relevantSourceIds: [],
      constraintSourceIds: [],
      referentSourceIds: [],
      pendingIntentSourceIds: [],
    };
    windowed.metadata = {
      ...windowed.metadata,
      completionContext: allPriorDialogue,
    };

    const { first, second, stored } = await unreviewedTurn(windowed);
    for (const request of [first, second]) {
      expect(request.input).not.toContain("action_source_review");
      expect(request.input).toContain("long exchange 2:");
      expect(JSON.stringify(request.tools)).not.toContain("RESTORE_CONTEXT");
    }
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(stored).toEqual(allPriorDialogue);
  });

  // Group voice is reviewed on no host. The planner is handed the turn's
  // context rather than its message, so the channel has to survive the
  // message service's own assembly.
  it.each([
    [ChannelType.DM, true],
    [ChannelType.VOICE_GROUP, false],
  ])(
    "on a host that reviews its turns, offers the review in a %s room: %j",
    async (channelType, offered) => {
      const context = await assembledTurn(channelType);
      // The same originals are reviewable in either room.
      expect(completionContextSources(context).sources).toHaveLength(30);
      const request = await firstPlannerRequest(context);
      expect(JSON.stringify(request.tools).includes(ACTION_CONTEXT_ARG)).toBe(
        offered,
      );
      expect(request.input.includes("action_source_review")).toBe(offered);
      expect(request.input).toContain("long exchange 29:");
    },
  );
});
