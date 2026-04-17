import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam } from "./param-parser.js";

export const smithAtAnvil: Action = {
  name: "SMITH_AT_ANVIL",
  description: "Smith a metal bar at a nearby anvil, optionally specifying what to make"
  descriptionCompressed: "Smith bar at nearby anvil.",
  similes: ["SMITHING", "USE_ANVIL"],
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

    const result = await service.executeAction("smithAtAnvil", { itemName });
    if (callback) callback({ text: result.message, action: "SMITH_AT_ANVIL" });
    return result;
  },
};
