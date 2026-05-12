// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import {
  createEvmLpProtocolProvider,
  registerLpProtocolProvider,
} from "../../../../lp/services/LpManagementService.ts";
import { UniswapV3LpService } from "./services/UniswapV3LpService.ts";

export const uniswapPlugin: Plugin = {
  name: "@elizaos/plugin-lp-manager/uniswap",
  description: "Uniswap V3 liquidity pool management plugin",
  services: [UniswapV3LpService],
  actions: [],
  providers: [],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    console.info("Uniswap V3 Plugin initialized");
    const service =
      runtime.getService<UniswapV3LpService>(
        UniswapV3LpService.serviceType,
      ) ?? (await UniswapV3LpService.start(runtime));
    await registerLpProtocolProvider(
      runtime,
      createEvmLpProtocolProvider({
        dex: "uniswap",
        label: "Uniswap V3",
        service,
      }),
    );
  },
};

export * from "./types.ts";
export { UniswapV3LpService };

export default uniswapPlugin;
