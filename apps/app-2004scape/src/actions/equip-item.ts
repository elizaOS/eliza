import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam } from "./param-parser.js";

export const equipItem: Action = {
  name: "EQUIP_ITEM",
  description: "Equip an item from inventory by name",
  descriptionCompressed: "Equip inventory item.",
  similes: ["WEAR_ITEM", "WIELD_ITEM"],
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

    const result = await service.executeAction("equipItem", { itemName });
    if (callback) callback({ text: result.message, action: "EQUIP_ITEM" });
    return result;
  },
};
