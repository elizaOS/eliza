import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const turnRightAction: Action = {
  name: "AINEX_TURN_RIGHT",
  similes: ["TURN_RIGHT", "ROTATE_RIGHT"],
  description: "Turn the AiNex robot to the right in place.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = "(ainex stub) turn right not implemented yet";
    await callback?.({ text });
    return { success: false, text };
  },
};
