import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const standAction: Action = {
  name: "AINEX_STAND",
  similes: ["STAND", "STAND_UP"],
  description: "Move the AiNex robot to its calibrated standing pose.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = "(ainex stub) stand not implemented yet";
    await callback?.({ text });
    return { success: false, text };
  },
};
