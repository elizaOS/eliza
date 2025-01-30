import { Action, IAgentRuntime, Memory, ServiceType } from "@elizaos/core";
import { ArbitrageService } from "../services/ArbitrageService";

export const executeArbitrageAction: Action = {
    name: "EXECUTE_ARBITRAGE",
    similes: ["TRADE_ARBITRAGE", "RUN_ARBITRAGE"],
    description: "Execute arbitrage trades across markets",

    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        // Validate settings are present
        return runtime.getSetting("arbitrage.walletPrivateKey") !== undefined;
    },

    handler: async (runtime: IAgentRuntime, _message: Memory) => {
        const service = runtime.getService(ServiceType.ARBITRAGE) as ArbitrageService;
        const markets = await service.evaluateMarkets();

        if (markets.length > 0) {
            await service.executeArbitrage(markets);
        }

        return true;
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Find arbitrage opportunities" }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Scanning for arbitrage trades",
                    action: "EXECUTE_ARBITRAGE"
                }
            }
        ]
    ]
};