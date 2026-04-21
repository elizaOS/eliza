import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam } from "./param-parser.js";

export const fish: Action = {
  name: "FISH",
  description: "Fish at a nearby fishing spot, optionally specifying the spot type"
  descriptionCompressed: "Fish at nearby spot, opt. type.",
  similes: ["GO_FISHING", "CATCH_FISH"],
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
    const spotName = extractParam(text, "spot");

    const result = await service.executeAction("fish", { spotName });
    if (callback) callback({ text: result.message, action: "FISH" });
    return result;
  },
};
