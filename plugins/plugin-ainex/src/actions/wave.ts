import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const waveAction: Action = {
  name: "AINEX_WAVE",
  similes: ["WAVE", "WAVE_HAND", "GREET"],
  description: "Play the wave gesture action group on the AiNex robot.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = "(ainex stub) wave not implemented yet";
    await callback?.({ text });
    return { success: false, text };
  },
};
