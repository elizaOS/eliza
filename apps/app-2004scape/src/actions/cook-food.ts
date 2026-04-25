import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam } from "./param-parser.js";

export const cookFood: Action = {
  name: "COOK_FOOD",
  description: "Cook raw food on a nearby fire or range, optionally specifying the food name",
  descriptionCompressed: "Cook raw food on fire/range.",
  similes: ["COOK", "COOK_RAW_FOOD"],
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    return _runtime.getService("rs_2004scape") != null;
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<unknown> => {
    const service = runtime.getService("rs_2004scape") as any;
    if (!service) return { success: false, message: "Game service not available." };

    const text = getCurrentLlmResponse();
    const rawFoodName = extractParam(text, "food");

    const result = await service.executeAction("cookFood", { rawFoodName });
    if (callback) callback({ text: result.message, action: "COOK_FOOD" });
    return result;
  },
};
