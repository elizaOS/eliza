import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const turnLeftAction: Action = {
  name: "AINEX_TURN_LEFT",
  similes: ["TURN_LEFT", "ROTATE_LEFT"],
  description: "Turn the AiNex robot to the left in place.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = "(ainex stub) turn left not implemented yet";
    await callback?.({ text });
    return { success: false, text };
  },
};
