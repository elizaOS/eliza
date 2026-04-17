import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";

export const fletchLogs: Action = {
  name: "FLETCH_LOGS",
  description: "Use a knife on logs in inventory to fletch them"
  descriptionCompressed: "Fletch logs with knife.",
  similes: ["FLETCHING", "CARVE_LOGS"],
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

    const result = await service.executeAction("fletchLogs", {});
    if (callback) callback({ text: result.message, action: "FLETCH_LOGS" });
    return result;
  },
};
