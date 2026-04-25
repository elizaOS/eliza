import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam, extractParamInt } from "./param-parser.js";

export const depositItem: Action = {
  name: "DEPOSIT_ITEM",
  description: "Deposit an item into the bank by name, optionally specifying a count (defaults to all)",
  descriptionCompressed: "Deposit item into bank.",
  similes: ["BANK_ITEM", "STORE_ITEM"],
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

    const result = await service.executeAction("depositItem", { itemName, count });
    if (callback) callback({ text: result.message, action: "DEPOSIT_ITEM" });
    return result;
  },
};
