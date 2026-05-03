import type { Plugin } from "@elizaos/core";
import { managePositions } from "./actions/managePositions";
import { managePositionActionRetriggerEvaluator } from "./evaluators/repositionEvaluator";
import { positionProvider } from "./providers/positionProvider";

export const orcaPlugin: Plugin = {
  name: "Orca LP Plugin",
  description: "Orca LP plugin",
  evaluators: [managePositionActionRetriggerEvaluator],
  providers: [positionProvider],
  actions: [managePositions],
  services: [],
};

export default orcaPlugin;
