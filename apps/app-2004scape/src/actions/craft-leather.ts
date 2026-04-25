import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";

export const craftLeather: Action = {
  name: "CRAFT_LEATHER",
  description: "Use a needle on leather in inventory to craft leather armour",
  descriptionCompressed: "Craft leather armour with needle.",
  similes: ["CRAFTING", "SEW_LEATHER"],
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

    const result = await service.executeAction("craftLeather", {});
    if (callback) callback({ text: result.message, action: "CRAFT_LEATHER" });
    return result;
  },
};
