// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import {
  createSolanaLpProtocolProvider,
  registerLpProtocolProvider,
} from "../../../../lp/services/LpManagementService.ts";
import { raydiumPositionProvider } from "./providers/positionProvider.ts";
import { RaydiumService } from "./services/srv_raydium.ts";

function hasExchangeRegistry(
  service: unknown
): service is { registerExchange: (exchange: { name: string }) => void } {
  return (
    service !== null &&
    typeof service === "object" &&
    typeof (service as { registerExchange?: unknown }).registerExchange === "function"
  );
}

export const raydiumPlugin: Plugin = {
  name: "@elizaos/plugin-lp-manager/raydium",
  description: "Raydium CLMM LP management plugin for Solana",
  actions: [],
  providers: [raydiumPositionProvider],
  services: [RaydiumService],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    console.info("Raydium Plugin initialized");
    const service =
      runtime.getService<RaydiumService>(RaydiumService.serviceType) ??
      (await RaydiumService.start(runtime));
    await registerLpProtocolProvider(
      runtime,
      createSolanaLpProtocolProvider({
        dex: "raydium",
        label: "Raydium",
        service,
      })
    );

    // Try to register with Solana service if available
    const serviceType = "solana";
    const solanaService = runtime.getService(serviceType);
    if (hasExchangeRegistry(solanaService)) {
      const me = {
        name: "Raydium DEX services",
      };
      solanaService.registerExchange(me);
      console.info("Raydium registered with Solana service");
    }
  },
};

export * from "./types.ts";
export { RaydiumService };

export default raydiumPlugin;
