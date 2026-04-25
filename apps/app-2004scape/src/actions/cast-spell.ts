import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { extractParam, extractParamInt } from "./param-parser.js";

export const castSpell: Action = {
  name: "CAST_SPELL",
  description: "Cast a spell by ID, optionally targeting an NPC",
  descriptionCompressed: "Cast spell by ID, opt. target NPC.",
  similes: ["USE_MAGIC", "CAST"],
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
    const spellId = extractParamInt(text, "spell");
    const targetNid = extractParam(text, "target");

    const result = await service.executeAction("castSpell", { spellId, targetNid });
    if (callback) callback({ text: result.message, action: "CAST_SPELL" });
    return result;
  },
};
