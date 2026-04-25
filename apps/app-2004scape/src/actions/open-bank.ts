import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";

export const openBank: Action = {
  name: "OPEN_BANK",
  description: "Open the nearest bank booth or banker NPC",
  descriptionCompressed: "Open nearest bank.",
  similes: ["USE_BANK", "ACCESS_BANK"],
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

    const result = await service.executeAction("openBank", {});
    if (callback) callback({ text: result.message, action: "OPEN_BANK" });
    return result;
  },
};
