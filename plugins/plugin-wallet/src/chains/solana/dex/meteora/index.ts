// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import {
  createSolanaLpProtocolProvider,
  registerLpProtocolProvider,
} from "../../../../lp/services/LpManagementService.ts";
import { meteoraScenarios } from "./e2e/scenarios.ts";
import { meteoraPositionProvider } from "./providers/positionProvider.ts";
import { MeteoraLpService } from "./services/MeteoraLpService.ts";

export const meteoraPlugin: Plugin = {
  name: "@elizaos/plugin-meteora",
  description: "A plugin for interacting with the Meteora DEX.",
  services: [MeteoraLpService],
  providers: [meteoraPositionProvider],
  tests: [meteoraScenarios],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    console.info("Meteora Plugin Initialized");
    const service =
      runtime.getService<MeteoraLpService>(MeteoraLpService.serviceType) ??
      (await MeteoraLpService.start(runtime));
    await registerLpProtocolProvider(
      runtime,
      createSolanaLpProtocolProvider({
        dex: "meteora",
        label: "Meteora",
        service,
      })
    );
  },
};

export default meteoraPlugin;
