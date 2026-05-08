// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { tokenInfoAction } from "../token-info/action";
import { TokenInfoService } from "../token-info/service";
import { registerDexScreenerSearchCategory } from "./search-category";
import { DexScreenerService } from "./service";

export const dexscreenerPlugin: Plugin = {
  name: "dexscreener-analytics-plugin",
  description: "Plugin for DexScreener DEX analytics and token information",
  actions: [tokenInfoAction],
  evaluators: [],
  providers: [],
  services: [DexScreenerService, TokenInfoService],
  init: async (_: Record<string, string>, _runtime: IAgentRuntime) => {
    registerDexScreenerSearchCategory(_runtime);
    console.log("DexScreener plugin initialized");
  },
};

export default dexscreenerPlugin;

export * from "./actions";
export { DexScreenerService } from "./service";
export * from "./types";
