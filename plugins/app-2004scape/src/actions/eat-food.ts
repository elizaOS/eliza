import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const eatFood: Action = {
  name: "EAT_FOOD",
  description: "Eat the first food item found in inventory",
  descriptionCompressed: "Eat food from inventory.",
  similes: ["CONSUME_FOOD", "HEAL"],
  examples: [],
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    return _runtime.getService("rs_2004scape") != null;
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<unknown> => {
    const service = getRsSdkGameService(runtime);
    if (!service)
      return { success: false, message: "Game service not available." };

    const result = await service.executeAction("eatFood", {});
    if (callback) callback({ text: result.message, action: "EAT_FOOD" });
    return result;
  },
};
