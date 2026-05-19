import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const sideStepLeftAction: Action = {
  name: "AINEX_SIDE_STEP_LEFT",
  similes: ["SIDE_STEP_LEFT", "STRAFE_LEFT"],
  description: "Side-step the AiNex robot to the left.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = "(ainex stub) side-step left not implemented yet";
    await callback?.({ text });
    return { success: false, text };
  },
};
