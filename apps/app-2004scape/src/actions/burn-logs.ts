import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";

export const burnLogs: Action = {
  name: "BURN_LOGS",
  description: "Use tinderbox on logs in inventory to light a fire"
  descriptionCompressed: "Use tinderbox on logs to light fire.",
  similes: ["LIGHT_FIRE", "FIREMAKING"],
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

    const result = await service.executeAction("burnLogs", {});
    if (callback) callback({ text: result.message, action: "BURN_LOGS" });
    return result;
  },
};
