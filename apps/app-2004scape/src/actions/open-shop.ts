import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam } from "./param-parser.js";

export const openShop: Action = {
  name: "OPEN_SHOP",
  description: "Open a shop by talking to a shopkeeper NPC"
  descriptionCompressed: "Open shop via shopkeeper.",
  similes: ["TRADE_WITH_NPC", "BROWSE_SHOP"],
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
    const npcName = extractParam(text, "npc");

    const result = await service.executeAction("openShop", { npcName });
    if (callback) callback({ text: result.message, action: "OPEN_SHOP" });
    return result;
  },
};
