import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam } from "./param-parser.js";

export const chopTree: Action = {
  name: "CHOP_TREE",
  description: "Chop a nearby tree, optionally specifying the tree type (oak, willow, etc.)",
  descriptionCompressed: "Chop nearby tree, opt. specify type.",
  similes: ["CUT_TREE", "WOODCUT"],
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
    const treeName = extractParam(text, "tree");

    const result = await service.executeAction("chopTree", { treeName });
    if (callback) callback({ text: result.message, action: "CHOP_TREE" });
    return result;
  },
};
