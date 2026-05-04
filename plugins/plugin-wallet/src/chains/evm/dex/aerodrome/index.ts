// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { AerodromeLpService } from "./services/AerodromeLpService.ts";

export const aerodromePlugin: Plugin = {
  name: "@elizaos/plugin-lp-manager/aerodrome",
  description: "Aerodrome DEX liquidity pool management plugin for Base chain",
  services: [AerodromeLpService],
  actions: [],
  evaluators: [],
  providers: [],
  init: async (_config: Record<string, string>, _runtime: IAgentRuntime) => {
    console.info("Aerodrome Plugin initialized");
  },
};

export * from "./types.ts";
export { AerodromeLpService };

export default aerodromePlugin;