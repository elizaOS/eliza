import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { managePositions } from "./actions/managePositions.ts";
import { managePositionActionRetriggerEvaluator } from "./evaluators/repositionEvaluator.ts";
import { positionProvider } from "./providers/positionProvider.ts";
import { OrcaService } from "./services/srv_orca.ts";

export const orcaPlugin: Plugin = {
  name: "@elizaos/plugin-lp-manager/orca",
  description: "Orca Whirlpool LP management plugin for Solana",
  evaluators: [managePositionActionRetriggerEvaluator],
  providers: [positionProvider],
  actions: [managePositions],
  services: [OrcaService],
  init: async (_config: Record<string, string>, _runtime: IAgentRuntime) => {
    console.info("Orca Plugin initialized");
  },
};

export { OrcaService };
export * from "./types.ts";

export default orcaPlugin;
