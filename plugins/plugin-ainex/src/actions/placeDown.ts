import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const placeDownAction: Action = {
  name: "AINEX_PLACE_DOWN",
  similes: ["PLACE_DOWN", "PUT_DOWN", "RELEASE"],
  description: "Run the place-down sequence on the AiNex robot.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = "(ainex stub) place down not implemented yet";
    await callback?.({ text });
    return { success: false, text };
  },
};
