import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParamInt } from "./param-parser.js";

export const navigateDialog: Action = {
  name: "NAVIGATE_DIALOG",
  description: "Select a dialog option by number (1-based) during an NPC conversation"
  descriptionCompressed: "Select NPC dialog option by number.",
  similes: ["SELECT_DIALOG", "CHOOSE_OPTION", "DIALOG_OPTION"],
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
    const option = extractParamInt(text, "option");

    const result = await service.executeAction("navigateDialog", { option });
    if (callback) callback({ text: result.message, action: "NAVIGATE_DIALOG" });
    return result;
  },
};
