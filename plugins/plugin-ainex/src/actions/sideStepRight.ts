import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const sideStepRightAction: Action = {
  name: "AINEX_SIDE_STEP_RIGHT",
  similes: ["SIDE_STEP_RIGHT", "STRAFE_RIGHT"],
  description: "Side-step the AiNex robot to the right.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = "(ainex stub) side-step right not implemented yet";
    await callback?.({ text });
    return { success: false, text };
  },
};
