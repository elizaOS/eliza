import type { Plugin, IAgentRuntime } from "@elizaos/core";
import { RaydiumService } from "./services/srv_raydium.ts";
import { raydiumPositionProvider } from "./providers/positionProvider.ts";
import { managePositionActionRetriggerEvaluator } from "./evaluators/repositionEvaluator.ts";
import { managePositions } from "./actions/managePositions.ts";

export const raydiumPlugin: Plugin = {
  name: "@elizaos/plugin-lp-manager/raydium",
  description: "Raydium CLMM LP management plugin for Solana",
  actions: [managePositions],
  evaluators: [managePositionActionRetriggerEvaluator],
  providers: [raydiumPositionProvider],
  services: [RaydiumService],
  init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
    console.info("Raydium Plugin initialized");

    // Try to register with Solana service if available
    const serviceType = "solana";
    const solanaService = runtime.getService(serviceType);
    if (solanaService && typeof (solanaService as unknown as Record<string, unknown>).registerExchange === 'function') {
      const me = {
        name: "Raydium DEX services",
      };
      (solanaService as unknown as { registerExchange: (exchange: { name: string }) => void }).registerExchange(me);
      console.info("Raydium registered with Solana service");
    }
  },
};

export { RaydiumService };
export * from "./types.ts";

export default raydiumPlugin;
