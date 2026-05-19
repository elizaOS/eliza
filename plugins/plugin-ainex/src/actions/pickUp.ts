import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const pickUpAction: Action = {
  name: "AINEX_PICK_UP",
  similes: ["PICK_UP", "GRAB"],
  description: "Run the pick-up sequence on the AiNex robot.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = "(ainex stub) pick up not implemented yet";
    await callback?.({ text });
    return { success: false, text };
  },
};
