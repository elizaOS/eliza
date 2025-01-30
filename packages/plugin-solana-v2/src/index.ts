import { Plugin } from "@elizaos/core";
import { positionProvider } from "./providers/orca/positionProvider";
import { managePositionActionRetriggerEvaluator } from "./evaluators/orca/repositionEvaluator";
import { managePositions } from "./actions/orca/managePositions";

export const solanaPluginV2: Plugin = {
    name: "solanaV2",
    description: "Solana Plugin V2 for Eliza",
    actions: [managePositions],
    evaluators: [managePositionActionRetriggerEvaluator],
    providers: [positionProvider],
};

export default solanaPluginV2;