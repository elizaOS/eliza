import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam } from "./param-parser.js";

export const interactObject: Action = {
  name: "INTERACT_OBJECT",
  description: "Interact with a world object by name, with an optional interaction option"
  descriptionCompressed: "Interact with world object.",
  similes: ["USE_OBJECT", "CLICK_OBJECT"],
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
    const objectName = extractParam(text, "object");
    const option = extractParam(text, "option");

    const result = await service.executeAction("interactObject", { objectName, option });
    if (callback) callback({ text: result.message, action: "INTERACT_OBJECT" });
    return result;
  },
};
