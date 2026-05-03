// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { managePositions } from "./actions/managePositions.ts";
import { managePositionActionRetriggerEvaluator } from "./evaluators/repositionEvaluator.ts";
import { raydiumPositionProvider } from "./providers/positionProvider.ts";
import { RaydiumService } from "./services/srv_raydium.ts";

export const raydiumPlugin: Plugin = {
  name: "@elizaos/plugin-lp-manager/raydium",
  description: "Raydium CLMM LP management plugin for Solana",
  actions: [managePositions],
  evaluators: [managePositionActionRetriggerEvaluator],
  providers: [raydiumPositionProvider],
  services: [RaydiumService],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    console.info("Raydium Plugin initialized");

    // Try to register with Solana service if available
    const serviceType = "solana";
    const solanaService = runtime.getService(serviceType);
    if (
      solanaService &&
      typeof (solanaService as unknown as Record<string, unknown>).registerExchange === "function"
    ) {
      const me = {
        name: "Raydium DEX services",
      };
      (
        solanaService as unknown as {
          registerExchange: (exchange: { name: string }) => void;
        }
      ).registerExchange(me);
      console.info("Raydium registered with Solana service");
    }
  },
};

export * from "./types.ts";
export { RaydiumService };

export default raydiumPlugin;