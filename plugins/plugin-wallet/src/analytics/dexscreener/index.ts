import type { Plugin, IAgentRuntime } from "@elizaos/core";
import { DexScreenerService } from "./service";
import { dexscreenerActions } from "./actions";

export const dexscreenerPlugin: Plugin = {
  name: "dexscreener-analytics-plugin",
  description: "Plugin for DexScreener DEX analytics and token information",
  actions: dexscreenerActions,
  evaluators: [],
  providers: [],
  services: [DexScreenerService],
  init: async (_: Record<string, string>, runtime: IAgentRuntime) => {
    console.log("DexScreener plugin initialized");
  },
};

export default dexscreenerPlugin;

export * from "./types";
export { DexScreenerService } from "./service";
export * from "./actions";
