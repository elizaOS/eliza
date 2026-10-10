/** A Stage-1 draft written beside declared work is a promise until that work runs. */
import {
  type ContextObject,
  ElizaError,
  type EvaluatorOutput,
  type JsonValue,
  type PlannerTrajectory,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { runPlannerLoop } from "../planner-loop";
import { stageOneEvent } from "./planner-fixtures";

const DRAFT = "There is nothing to cancel.";

function stageOneContext(
  plan: Record<string, JsonValue>,
  metadata: ContextObject["metadata"] = {},
): ContextObject {
  return {
    id: "stage-one-draft",
    metadata,
    events: [
      stageOneEvent({
        plan: {
          replyEffectStatus: "none",
          reply: DRAFT,
          candidateActions: ["OWNER_REMINDERS"],
          ...plan,
        },
      }),
    ],
  };
}

async function runDraftTurn(
  context: ContextObject,
  evaluate: (args: {
    trajectory: PlannerTrajectory;
  }) => Promise<EvaluatorOutput> | EvaluatorOutput,
) {
  const order: string[] = [];
  let plannerCalls = 0;
  const result = await runPlannerLoop({
    runtime: {
      useModel: async () => {
        order.push("planner");
        return ++plannerCalls === 1
          ? {
              text: "",
              toolCalls: [
                {
                  id: "cancel",
                  name: "OWNER_REMINDERS",
                  arguments: {
                    action: "cancel",
                    title: "bill",
                    eliza_turn_scope: "final",
                  },
                },
              ],
            }
          : {
              text: "",
              toolCalls: [
                {
                  id: "reply",
                  name: "REPLY",
                  arguments: {
                    text: "Cancelled the bill reminder.",
                    eliza_turn_scope: "final",
                  },
                },
              ],
            };
      },
    },
    context,
    requireNonTerminalToolCall: true,
    tools: [
      {
        name: "OWNER_REMINDERS",
        description: "Create, list or cancel owner reminders.",
        parameters: { type: "object", properties: {} },
      },
    ],
    executeToolCall: async () => {
      order.push("tool");
      return {
        success: true,
        text: "Cancelled reminder: Pay the bill.",
        userFacingText: "Cancelled reminder: Pay the bill.",
      };
    },
    evaluate: async (args) => {
      order.push("evaluate");
      return evaluate(args);
    },
  });
  return { result, order };
}

// A judge that accepts the unexecuted draft while no step has run and
// confirms the recorded outcome after one has.
function acceptDraftWithoutWork({
  trajectory,
}: {
  trajectory: PlannerTrajectory;
}): EvaluatorOutput {
  return trajectory.steps.some((step) => step.toolCall && step.result)
    ? {
        success: true,
        decision: "FINISH",
        thought: "The reminder was cancelled.",
        messageToUser: "Cancelled the bill reminder.",
      }
    : {
        success: true,
        decision: "FINISH",
        thought: "Stage 1 already answered.",
        messageToUser: DRAFT,
      };
}

describe("unexecuted Stage-1 draft", () => {
  it("plans a Calendar read Stage 1 bound as required", async () => {
    const { result, order } = await runDraftTurn(
      stageOneContext(
        { contexts: ["general"], intents: ["find the design review call"] },
        {
          calendarReadBindings: [
            {
              intentId: "intent:1",
              operation: "search_events",
              execution: "required",
            },
          ],
        },
      ),
      acceptDraftWithoutWork,
    );
    expect(order[0]).toBe("planner");
    expect(result.finalMessage).not.toBe(DRAFT);
  });

  it("plans the request when judging the draft fails before output", async () => {
    let judged = 0;
    const { result, order } = await runDraftTurn(
      stageOneContext({
        contexts: ["tasks"],
        intents: ["cancel the bill reminder"],
      }),
      (args) => {
        if (judged++ === 0)
          throw new ElizaError(
            "Structured output stopped making JSON progress; the incomplete request was aborted.",
            { code: "STRUCTURED_OUTPUT_STALLED" },
          );
        return acceptDraftWithoutWork(args);
      },
    );
    expect(order.slice(0, 3)).toEqual(["evaluate", "planner", "tool"]);
    expect(result.finalMessage).toBe("Cancelled the bill reminder.");
  });
});
