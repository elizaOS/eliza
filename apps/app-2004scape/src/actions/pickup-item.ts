import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam } from "./param-parser.js";

export const pickupItem: Action = {
  name: "PICKUP_ITEM",
  description: "Pick up an item from the ground by name"
  descriptionCompressed: "Pick up ground item.",
  similes: ["TAKE_ITEM", "GRAB_ITEM", "LOOT_ITEM"],
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

    const result = await service.executeAction("pickupItem", { itemName });
    if (callback) callback({ text: result.message, action: "PICKUP_ITEM" });
    return result;
  },
};
