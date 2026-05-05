// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { dexscreenerActions } from "./actions";
import { DexScreenerService } from "./service";

export const dexscreenerPlugin: Plugin = {
  name: "dexscreener-analytics-plugin",
  description: "Plugin for DexScreener DEX analytics and token information",
  actions: dexscreenerActions,
  evaluators: [],
  providers: [],
  services: [DexScreenerService],
  init: async (_: Record<string, string>, _runtime: IAgentRuntime) => {
    console.log("DexScreener plugin initialized");
  },
};

export default dexscreenerPlugin;

export * from "./actions";
export { DexScreenerService } from "./service";
export * from "./types";
