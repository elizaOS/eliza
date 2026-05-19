import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const setServoAction: Action = {
  name: "AINEX_SET_SERVO",
  similes: ["SET_SERVO", "MOVE_SERVO", "MOVE_JOINT"],
  description:
    "Drive a single AiNex servo / joint to a target angle over a given duration.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = "(ainex stub) set servo not implemented yet";
    await callback?.({ text });
    return { success: false, text };
  },
};
