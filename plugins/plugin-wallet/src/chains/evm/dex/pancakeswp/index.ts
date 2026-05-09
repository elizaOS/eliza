// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import {
  createEvmLpProtocolProvider,
  registerLpProtocolProvider,
} from "../../../../lp/services/LpManagementService.ts";
import { PancakeSwapV3LpService } from "./services/PancakeSwapV3LpService.ts";

export const pancakeswapPlugin: Plugin = {
  name: "@elizaos/plugin-lp-manager/pancakeswap",
  description: "PancakeSwap V3 liquidity pool management plugin",
  services: [PancakeSwapV3LpService],
  actions: [],
  providers: [],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    console.info("PancakeSwap V3 Plugin initialized");
    const service =
      runtime.getService<PancakeSwapV3LpService>(
        PancakeSwapV3LpService.serviceType,
      ) ?? (await PancakeSwapV3LpService.start(runtime));
    await registerLpProtocolProvider(
      runtime,
      createEvmLpProtocolProvider({
        dex: "pancakeswap",
        label: "PancakeSwap V3",
        service,
      }),
    );
  },
};

export * from "./types.ts";
export { PancakeSwapV3LpService };

export default pancakeswapPlugin;
