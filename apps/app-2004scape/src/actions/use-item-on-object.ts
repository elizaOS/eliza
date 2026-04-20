import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam } from "./param-parser.js";

export const useItemOnObject: Action = {
  name: "USE_ITEM_ON_OBJECT",
  description: "Use an inventory item on a world object (e.g. ore on furnace)"
  descriptionCompressed: "Use inventory item on world object.",
  similes: ["ITEM_ON_OBJECT"],
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
    const objectName = extractParam(text, "object");

    const result = await service.executeAction("useItemOnObject", { itemName, objectName });
    if (callback) callback({ text: result.message, action: "USE_ITEM_ON_OBJECT" });
    return result;
  },
};
