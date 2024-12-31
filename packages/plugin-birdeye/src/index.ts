import { Plugin } from "@elizaos/core";
import { getTokenInfoAction } from "./actions/get-token-info";
import { getWalletInfoAction } from "./actions/get-wallet-info";
import { agentPortfolioProvider } from "./providers/agent-portfolio-provider";

export const birdeyePlugin: Plugin = {
    name: "birdeye",
    description: "Birdeye Plugin for token data and analytics",
    actions: [
        getTokenInfoAction,
        getWalletInfoAction,
        // testAllEndpointsAction, // this action can be used to optionally test all endpoints
    ],
    evaluators: [],
    providers: [agentPortfolioProvider],
};

export default birdeyePlugin;
