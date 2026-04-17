import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParamInt } from "./param-parser.js";

export const setCombatStyle: Action = {
  name: "SET_COMBAT_STYLE",
  description: "Set the combat style (0=Attack, 1=Strength, 2=Defence, 3=Controlled)"
  descriptionCompressed: "Set combat style (Attack/Strength/Defence/Controlled).",
  similes: ["CHANGE_COMBAT_STYLE", "SWITCH_COMBAT"],
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
    const style = extractParamInt(text, "style");

    const result = await service.executeAction("setCombatStyle", { style });
    if (callback) callback({ text: result.message, action: "SET_COMBAT_STYLE" });
    return result;
  },
};
