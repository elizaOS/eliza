import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam } from "./param-parser.js";

export const pickpocketNpc: Action = {
  name: "PICKPOCKET_NPC",
  description: "Pickpocket a nearby NPC by name"
  descriptionCompressed: "Pickpocket nearby NPC.",
  similes: ["STEAL_FROM_NPC", "THIEVE_NPC"],
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

    const result = await service.executeAction("pickpocketNpc", { npcName });
    if (callback) callback({ text: result.message, action: "PICKPOCKET_NPC" });
    return result;
  },
};
