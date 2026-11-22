/**
 * An umbrella action reached through the sub-planner, whose inner action's
 * own model call sent no cap and stopped at the model's output limit, is not
 * called again by the outer planner. The inner loop already stops after one
 * such call; without carrying that stop out, the outer planner saw an
 * ordinary failure and re-called the umbrella up to its repeat budget, each
 * call spending the model's whole output maximum again.
 *
 * Everything below the scripted model is real: the outer and inner planner
 * loops, the message service's planned-tool dispatch, the sub-planner, core's
 * planned-tool executor and its handler settlement.
 */
import {
  type Action,
  ElizaError,
  type IAgentRuntime,
  type Memory,
  ModelType,
  TrajectoryLimitExceeded,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { executeV5PlannedToolCall } from "../../services/message/planned-tool.ts";
import { type PlannerRuntime, runPlannerLoop } from "../planner-loop";

/**
 * What the TEXT_LARGE adapter throws for an extractor cut off at a length
 * stop: `maxTokens` is the cap it sent, null for none.
 */
const cutOff = (maxTokens: number | null) =>
  new ElizaError(
    "[cerebras] Model output did not complete successfully (length).",
    {
      code: "MODEL_OUTPUT_INCOMPLETE",
      context: {
        finishReason: "length",
        provider: "cerebras",
        model: "qwen-3.8-27b",
        maxTokens,
        usage: { completionTokens: 4096, reasoningTokens: 4096 },
        modelType: "TEXT_LARGE",
      },
    },
  );

const UMBRELLA = "OWNER_REMINDERS";
const CHILD = "OWNER_REMINDERS_CREATE";
const ARGS = { text: "take out the trash at 8pm" };

/**
 * Plan a turn whose outer planner keeps calling the reminder umbrella without
 * its discriminator, so each call descends into the sub-planner, whose model
 * keeps calling the create child, whose handler throws `failure`.
 */
async function plan(failure: Error) {
  let handlerCalls = 0;
  let umbrellaCalls = 0;
  let plannerCalls = 0;
  const child: Action = {
    name: CHILD,
    description: "Create a reminder.",
    parameters: [
      {
        name: "text",
        description: "What to be reminded of.",
        required: false,
        schema: { type: "string" },
      },
    ],
    validate: async () => true,
    handler: async () => {
      handlerCalls++;
      throw failure;
    },
  };
  const umbrella: Action = {
    name: UMBRELLA,
    description: "Manage the owner's reminders.",
    parameters: child.parameters,
    subActions: [child],
    validate: async () => true,
    handler: async () => {
      throw new Error("The umbrella's own handler never runs here");
    },
  };
  const toolCall = (name: string, id: string) => ({
    text: "",
    toolCalls: [
      {
        id,
        name,
        arguments: { ...ARGS, eliza_turn_scope: "final" },
      },
    ],
  });
  const runtime = {
    actions: [umbrella, child],
    agentId: "00000000-0000-0000-0000-000000000001",
    getRoom: async () => null,
    getWorld: async () => null,
    getService: () => undefined,
    getSetting: () => undefined,
    emitEvent: async () => {},
    reportError: () => {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    useModel: async (
      type: string,
      input: { tools?: Array<{ name: string }> },
    ) => {
      if (type !== ModelType.ACTION_PLANNER)
        throw new Error(`Unexpected model call ${type}`);
      if (++plannerCalls > 30) throw new Error("The planner never stopped");
      // The sub-planner offers the child; the outer planner the umbrella.
      return input.tools?.some((tool) => tool.name === CHILD)
        ? toolCall(CHILD, `inner-${plannerCalls}`)
        : toolCall(UMBRELLA, `outer-${plannerCalls}`);
    },
  } as unknown as IAgentRuntime & PlannerRuntime;
  const message = {
    id: "00000000-0000-0000-0000-0000000000aa",
    roomId: "00000000-0000-0000-0000-0000000000bb",
    entityId: "00000000-0000-0000-0000-0000000000cc",
    agentId: runtime.agentId,
    content: { text: "Remind me to take out the trash at 8pm." },
  } as Memory;
  const context = { id: "sub-planner-model-output-limit", events: [] };
  const evaluate = async () => ({
    success: false,
    decision: "CONTINUE" as const,
    thought: "The reminder was not created.",
  });
  const outcome = await runPlannerLoop({
    runtime,
    context,
    tools: [
      {
        name: UMBRELLA,
        description: umbrella.description,
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
        },
      },
    ],
    executeToolCall: async (call) => {
      if (call.name === UMBRELLA) umbrellaCalls++;
      return executeV5PlannedToolCall({
        runtime,
        plannerRuntime: runtime,
        plannerContext: context,
        toolCall: call,
        executorCtx: {
          message,
          state: { values: {}, data: {}, text: "" },
          userRoles: ["OWNER"],
          activeContexts: ["general"],
        },
        executorOptions: { actions: [umbrella, child] },
        evaluate,
      });
    },
    evaluate,
  }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  return { outcome, handlerCalls, umbrellaCalls };
}

describe("an umbrella whose inner action's model call stopped at a length limit", () => {
  it("is called once by the outer planner when its inner call sent no cap", async () => {
    const { outcome, handlerCalls, umbrellaCalls } = await plan(cutOff(null));
    expect(umbrellaCalls).toBe(1);
    expect(handlerCalls).toBe(1);
    expect("error" in outcome && outcome.error).toBeInstanceOf(
      TrajectoryLimitExceeded,
    );
    expect(outcome).toMatchObject({
      error: {
        kind: "repeated_failures",
        max: 0,
        observed: 1,
        message: expect.stringContaining(`${UMBRELLA}:model_output_limit`),
      },
    });
    // The turn ends on the outer planner's own limit, as for an action called
    // directly; the model error stays on the umbrella's recorded result.
    expect("error" in outcome && (outcome.error as Error).cause).toBe(
      undefined,
    );
  });

  it("keeps the repeat budget at both levels when its inner call was cut off under a sent cap", async () => {
    const { outcome, handlerCalls, umbrellaCalls } = await plan(cutOff(4096));
    expect(umbrellaCalls).toBe(3);
    expect(handlerCalls).toBe(9);
    expect(outcome).toMatchObject({
      error: { kind: "repeated_failures", max: 2, observed: 3 },
    });
  });

  it("keeps the repeat budget at both levels for an unrelated inner failure", async () => {
    const { outcome, handlerCalls, umbrellaCalls } = await plan(
      new Error("The reminder store is unavailable."),
    );
    expect(umbrellaCalls).toBe(3);
    expect(handlerCalls).toBe(9);
    expect(outcome).toMatchObject({
      error: { kind: "repeated_failures", max: 2, observed: 3 },
    });
  });
});
