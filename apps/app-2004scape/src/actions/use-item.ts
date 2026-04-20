import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam } from "./param-parser.js";

export const useItem: Action = {
  name: "USE_ITEM",
  description: "Use an item from inventory by name"
  descriptionCompressed: "Use inventory item.",
  similes: ["ACTIVATE_ITEM"],
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

    const result = await service.executeAction("useItem", { itemName });
    if (callback) callback({ text: result.message, action: "USE_ITEM" });
    return result;
  },
};
