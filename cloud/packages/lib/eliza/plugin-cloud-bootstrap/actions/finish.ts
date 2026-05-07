import type { ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { type ActionWithParams, defineActionParameters } from "../types";

/**
 * FINISH action - compatibility terminal tool for planners that still emit an
 * explicit final tool call instead of v5 toolCalls: [] plus messageToUser.
 *
 * NOTE: The handler is never called in normal flow. runNativePlannerCore() intercepts
 * action === "FINISH" before processActions() runs, extracts the response param,
 * and returns directly. The handler exists for registry completeness and
 * non-multi-step contexts.
 *
 * @see cloud-bootstrap-message-service.ts runNativePlannerCore() FINISH intercept
 */
export const finishAction: ActionWithParams = {
  name: "FINISH",
  description:
    "Complete the task and respond to the user. Call this when all actions are done " +
    "or the user's request is fully satisfied. Provide your final response in character.",
  parameters: defineActionParameters({
    response: {
      type: "string",
      description:
        "Your final response to the user summarizing what was accomplished, written in character.",
      required: true,
    },
  }),

  validate: async () => true,

  // Intercepted by the native planner loop; this is a fallback for non-multi-step contexts.
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const content = message.content as Record<string, unknown>;
    const params =
      (content.actionParams as Record<string, unknown>) ||
      (content.actionInput as Record<string, unknown>) ||
      {};

    const response = (params.response as string) || "";

    return { success: true, text: response };
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "What's the weather today?" } },
      {
        name: "{{assistant}}",
        content: {
          text: "Task complete.",
          actions: ["FINISH"],
        },
      },
    ],
  ],
};
