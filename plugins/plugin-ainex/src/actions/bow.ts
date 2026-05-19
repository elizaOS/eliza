import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const bowAction: Action = {
  name: "AINEX_BOW",
  similes: ["BOW"],
  description: "Play the bow action group on the AiNex robot.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = "(ainex stub) bow not implemented yet";
    await callback?.({ text });
    return { success: false, text };
  },
};
