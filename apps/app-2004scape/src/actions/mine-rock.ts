import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam } from "./param-parser.js";

export const mineRock: Action = {
  name: "MINE_ROCK",
  description: "Mine a nearby rock, optionally specifying the ore type (copper, tin, iron, etc.)"
  descriptionCompressed: "Mine nearby rock, opt. ore type.",
  similes: ["MINE_ORE", "MINE"],
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
    const rockName = extractParam(text, "rock");

    const result = await service.executeAction("mineRock", { rockName });
    if (callback) callback({ text: result.message, action: "MINE_ROCK" });
    return result;
  },
};
