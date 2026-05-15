import type { IAgentRuntime, Plugin } from "@elizaos/core";
import {
  createSolanaLpProtocolProvider,
  registerLpProtocolProvider,
} from "../../../../lp/services/LpManagementService.ts";

export const meteoraPlugin: Plugin = {
  name: "@elizaos/plugin-meteora",
  description: "A plugin for interacting with the Meteora DEX.",
  services: [],
  providers: [],
  tests: [],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    try {
      const serviceModulePath = "./services/MeteoraLpService.ts";
      const { MeteoraLpService } = await import(serviceModulePath);
      console.info("Meteora Plugin Initialized");
      const service =
        runtime.getService(MeteoraLpService.serviceType) ?? (await MeteoraLpService.start(runtime));
      await registerLpProtocolProvider(
        runtime,
        createSolanaLpProtocolProvider({
          dex: "meteora",
          label: "Meteora",
          service: service as Parameters<typeof createSolanaLpProtocolProvider>[0]["service"],
        })
      );
    } catch (error) {
      console.warn(
        "[Meteora] Optional DLMM dependency failed to load; Meteora LP support is disabled.",
        error instanceof Error ? error.message : String(error)
      );
    }
  },
};

export default meteoraPlugin;
