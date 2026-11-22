/**
 * An action whose own model call sent no cap and stopped at the model's output
 * limit is not called again in the turn. Each such call already spent the
 * model's whole maximum (40,960 tokens on qwen-3.8-27b), and the planner
 * re-called a failing action until the repeated-failure limit: a 2026-11-20
 * eval turn ran three identical reminder extractor cut-offs.
 */
import {
  type Action,
  ElizaError,
  type IAgentRuntime,
  settleActionHandler,
  TrajectoryLimitExceeded,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  actionResultToPlannerToolResult,
  runPlannerLoop,
} from "../planner-loop";

/**
 * What the TEXT_LARGE adapter throws for an extractor cut off at a length
 * stop: `maxTokens` is the cap it sent, null for none; undefined leaves the
 * cap unreported.
 */
const cutOff = (maxTokens?: number | null) =>
  new ElizaError(
    "[cerebras] Model output did not complete successfully (length).",
    {
      code: "MODEL_OUTPUT_INCOMPLETE",
      context: {
        finishReason: "length",
        provider: "cerebras",
        model: "qwen-3.8-27b",
        ...(maxTokens === undefined ? {} : { maxTokens }),
        usage: { completionTokens: 4096, reasoningTokens: 4096 },
        modelType: "TEXT_LARGE",
      },
    },
  );

const REMINDER: Action = {
  name: "OWNER_REMINDERS_CREATE",
  description: "Create a reminder.",
  validate: async () => true,
  handler: async () => ({ success: true }),
};
const settlementRuntime = {
  agentId: "00000000-0000-0000-0000-000000000001",
  logger: { debug() {}, info() {}, warn() {}, error() {} },
} as unknown as IAgentRuntime;

/**
 * Plan a turn whose planner keeps calling the reminder action and whose
 * extractor throws `failure`. The handler error settles through the real
 * action boundary into the planner's tool result, as it does live.
 */
async function plan(failure: Error) {
  let handlerCalls = 0;
  let plannerCalls = 0;
  const outcome = await runPlannerLoop({
    runtime: {
      useModel: async () => {
        plannerCalls++;
        if (plannerCalls > 6) throw new Error("The planner never stopped");
        return {
          text: "",
          toolCalls: [
            {
              id: `create-${plannerCalls}`,
              name: REMINDER.name,
              arguments: {
                text: "take out the trash at 8pm",
                eliza_turn_scope: "final",
              },
            },
          ],
        };
      },
    },
    context: { id: "planner-model-output-limit", events: [] },
    tools: [
      {
        name: REMINDER.name,
        description: REMINDER.description,
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
        },
      },
    ],
    executeToolCall: async () =>
      actionResultToPlannerToolResult(
        await settleActionHandler({
          runtime: settlementRuntime,
          action: REMINDER,
          invoke: async () => {
            handlerCalls++;
            throw failure;
          },
        }),
      ),
    evaluate: async () => ({
      success: false,
      decision: "CONTINUE",
      thought: "The reminder was not created.",
    }),
  }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  return { outcome, handlerCalls, plannerCalls };
}

describe("an action whose model call stopped at a length limit", () => {
  it("an action whose model call stopped at the model's own limit is not called again in the turn", async () => {
    const { outcome, handlerCalls } = await plan(cutOff(null));
    expect(handlerCalls).toBe(1);
    expect("error" in outcome && outcome.error).toBeInstanceOf(
      TrajectoryLimitExceeded,
    );
    expect(outcome).toMatchObject({
      error: { kind: "repeated_failures", max: 0, observed: 1 },
    });
  });

  it("a cut-off under a sent cap keeps the repeat budget", async () => {
    const { outcome, handlerCalls } = await plan(cutOff(4096));
    expect(handlerCalls).toBe(3);
    expect(outcome).toMatchObject({
      error: { kind: "repeated_failures", max: 2, observed: 3 },
    });
  });

  it("a cut-off that does not report its cap keeps the repeat budget", async () => {
    const { handlerCalls } = await plan(cutOff());
    expect(handlerCalls).toBe(3);
  });
});
