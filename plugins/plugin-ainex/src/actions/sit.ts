import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const sitAction: Action = {
  name: "AINEX_SIT",
  similes: ["SIT", "SIT_DOWN"],
  description: "Move the AiNex robot into a seated/crouched pose.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = "(ainex stub) sit not implemented yet";
    await callback?.({ text });
    return { success: false, text };
  },
};
