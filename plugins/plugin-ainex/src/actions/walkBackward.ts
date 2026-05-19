import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const walkBackwardAction: Action = {
  name: "AINEX_WALK_BACKWARD",
  similes: ["WALK_BACKWARD", "MOVE_BACKWARD", "GO_BACK"],
  description: "Make the AiNex robot walk backward at the configured gait speed.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = "(ainex stub) walk backward not implemented yet";
    await callback?.({ text });
    return { success: false, text };
  },
};
