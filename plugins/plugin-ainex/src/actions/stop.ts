import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const stopAction: Action = {
  name: "AINEX_STOP",
  similes: ["STOP", "HALT", "FREEZE"],
  description:
    "Stop the AiNex robot immediately, preempting any in-flight walk or action group.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = "(ainex stub) stop not implemented yet";
    await callback?.({ text });
    return { success: false, text };
  },
};
