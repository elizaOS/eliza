import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam } from "./param-parser.js";

export const useItemOnItem: Action = {
  name: "USE_ITEM_ON_ITEM",
  description: "Use one inventory item on another (e.g. tinderbox on logs)",
  descriptionCompressed: "Use inventory item on another.",
  similes: ["COMBINE_ITEMS"],
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
    const itemName1 = extractParam(text, "item1");
    const itemName2 = extractParam(text, "item2");

    const result = await service.executeAction("useItemOnItem", { itemName1, itemName2 });
    if (callback) callback({ text: result.message, action: "USE_ITEM_ON_ITEM" });
    return result;
  },
};
