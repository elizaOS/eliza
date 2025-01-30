import { Plugin, Action, Provider, IAgentRuntime } from "@elizaos/core";
import { executeArbitrageAction } from "./actions/arbitrageAction";
import { marketProvider } from "./providers/marketProvider";
import { ArbitrageService } from "./services/ArbitrageService";
// Create a single instance of the service

const arbitrageService = new ArbitrageService();

const arbitragePlugin: Plugin = {
    name: "arbitrage-plugin",
    description: "Automated arbitrage trading plugin",
    actions: [executeArbitrageAction],
    providers: [marketProvider],
    services: [arbitrageService]
};

export default arbitragePlugin;