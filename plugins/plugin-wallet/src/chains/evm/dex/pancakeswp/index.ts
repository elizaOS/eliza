// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { PancakeSwapV3LpService } from "./services/PancakeSwapV3LpService.ts";

export const pancakeswapPlugin: Plugin = {
  name: "@elizaos/plugin-lp-manager/pancakeswap",
  description: "PancakeSwap V3 liquidity pool management plugin",
  services: [PancakeSwapV3LpService],
  actions: [],
  evaluators: [],
  providers: [],
  init: async (_config: Record<string, string>, _runtime: IAgentRuntime) => {
    console.info("PancakeSwap V3 Plugin initialized");
  },
};

export * from "./types.ts";
export { PancakeSwapV3LpService };

export default pancakeswapPlugin;