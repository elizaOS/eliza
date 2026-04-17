import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam, extractParamInt } from "./param-parser.js";

export const walkTo: Action = {
  name: "WALK_TO",
  description: "Walk the player to a coordinate or named destination (e.g. bank, lumbridge)"
  descriptionCompressed: "Walk to coordinate or named destination.",
  similes: ["MOVE_TO", "GO_TO", "TRAVEL_TO"],
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
    const destination = extractParam(text, "destination");
    const x = extractParamInt(text, "x");
    const z = extractParamInt(text, "z");

    const result = await service.executeAction("walkTo", { x, z, destination });
    if (callback) callback({ text: result.message, action: "WALK_TO" });
    return result;
  },
};
