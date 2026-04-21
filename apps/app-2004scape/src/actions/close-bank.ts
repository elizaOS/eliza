import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";

export const closeBank: Action = {
  name: "CLOSE_BANK",
  description: "Close the bank interface"
  descriptionCompressed: "Close bank interface.",
  similes: ["EXIT_BANK"],
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

    const result = await service.executeAction("closeBank", {});
    if (callback) callback({ text: result.message, action: "CLOSE_BANK" });
    return result;
  },
};
