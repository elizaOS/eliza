import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const walkForwardAction: Action = {
  name: "AINEX_WALK_FORWARD",
  similes: ["WALK_FORWARD", "MOVE_FORWARD", "GO_FORWARD"],
  description: "Make the AiNex robot walk forward at the configured gait speed.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = "(ainex stub) walk forward not implemented yet";
    await callback?.({ text });
    return { success: false, text };
  },
};
