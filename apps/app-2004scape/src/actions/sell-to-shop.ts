import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam, extractParamInt } from "./param-parser.js";

export const sellToShop: Action = {
  name: "SELL_TO_SHOP",
  description: "Sell an item to the currently open shop, optionally specifying a count (defaults to 1)"
  descriptionCompressed: "Sell item to open shop.",
  similes: ["SELL_ITEM"],
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
    const itemName = extractParam(text, "item");
    const count = extractParamInt(text, "count");

    const result = await service.executeAction("sellToShop", { itemName, count });
    if (callback) callback({ text: result.message, action: "SELL_TO_SHOP" });
    return result;
  },
};
