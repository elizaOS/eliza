import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";

export const openDoor: Action = {
  name: "OPEN_DOOR",
  description: "Open the nearest door or gate",
  descriptionCompressed: "Open nearest door/gate.",
  similes: ["OPEN_GATE", "USE_DOOR"],
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

    const result = await service.executeAction("openDoor", {});
    if (callback) callback({ text: result.message, action: "OPEN_DOOR" });
    return result;
  },
};
