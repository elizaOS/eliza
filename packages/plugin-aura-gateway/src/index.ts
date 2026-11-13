import { Plugin } from "@elizaos/core";
import { travelAggregateAction, visionProcessAction } from "./actions";

export const auraGatewayPlugin: Plugin = {
    name: "plugin-aura-gateway",
    description:
        "Enables autonomous agents to access M2M monetization endpoints on Base Mainnet for travel aggregation and computer vision.",
    actions: [travelAggregateAction, visionProcessAction],
    providers: [],
    evaluators: []
};

export default auraGatewayPlugin;
