import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { derivePolymarketStatusText } from "./provider-text";

export const polymarketStatusProvider: Provider = {
  name: "POLYMARKET_STATUS",
  description:
    "Polymarket app readiness context including public reads and trading configuration.",
  dynamic: true,
  contexts: ["finance", "crypto"],
  contextGate: { anyOf: ["finance", "crypto"] },
  cacheStable: false,
  cacheScope: "turn",
  get: async (_runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const status = derivePolymarketStatusText(process.env);
    return {
      text: status.text,
      data: status.data,
    };
  },
};
