/**
 * On a short conversation the planner's action source review cost more than
 * the transcript it could defer, and its per-turn source identity made every
 * domain tool definition differ from the previous turn's.
 */
import {
  type ContextEvent,
  type ContextObject,
  completionContextSources,
  type ToolDefinition,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  projectBackgroundHistory,
  projectReviewedHistory,
  withBackgroundHistory,
} from "../../services/message/history-discovery.ts";
import {
  applyHistoryRetentionReview,
  prepareHistoryRetention,
} from "../history-retention.ts";
import { ACTION_CONTEXT_ARG, runPlannerLoop } from "../planner-loop.ts";

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

/** The first planner request of a turn that replies at once. */
async function firstPlannerRequest(
  context: ContextObject,
  tools: ToolDefinition[] = [CREATE],
) {
  const requests: Array<{ tools: ToolDefinition[]; input: string }> = [];
  await runPlannerLoop({
    runtime: {
      useModel: async (_type: unknown, params: Record<string, unknown>) => {
        requests.push({
          tools: params.tools as ToolDefinition[],
          input: JSON.stringify(params.messages),
        });
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

  it("still offers the review on a long transcript, bound to that turn's originals", async () => {
    const context = turn("turn-1", dialogue(30, LONG));
    const first = await firstPlannerRequest(context);
    const create = first.tools.find((tool) => tool.name === CREATE.name);
    expect(create?.parameters?.required).toContain(ACTION_CONTEXT_ARG);
    expect(
      create?.parameters?.properties?.[ACTION_CONTEXT_ARG]?.properties
        ?.sourceSetId?.enum,
    ).toEqual([completionContextSources(context).sourceSetId]);
    expect(first.input).toContain("action_source_review");
    expect(first.input).toContain("Completion-context field instructions");
    expect(first.input).toContain("[h30]");

    const second = await firstPlannerRequest(
      turn("turn-2", dialogue(32, LONG)),
    );
    expect(JSON.stringify(second.tools)).not.toBe(JSON.stringify(first.tools));
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
