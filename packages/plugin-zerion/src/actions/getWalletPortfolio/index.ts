import { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { zerionProvider } from "../../providers/index.ts";
import { formatPortfolioData } from "../../utils.ts";
import { PortfolioData, PositionData } from "../../types.ts";
import examples from "./examples.ts";



export const getWalletPortfolio: Action = {
    name: "getwallet_portfolio",
    description: "Fetch a wallet's portfolio data from Zerion for an address",
    similes: [
        "getwallet_portfolio",
        "displayportfolio",
        "getwallet_holdings",
        "getwallet_balance",
        "getwallet_value",
        "get_portfolio_value",
        "get wallet portfolio",
        "get wallet holdings",
        "get wallet balance",
        "get wallet value",
    ],
    examples: examples,
    validate: async (_runtime: IAgentRuntime, message: Memory) => {

        const addressRegex = /0x[a-fA-F0-9]{40}/;
        return addressRegex.test(message.content.text);
    },
    handler: async (runtime: IAgentRuntime, message: Memory, _state?: State, _options?: { [key: string]: unknown; }, callback?: HandlerCallback): Promise<boolean> => {
        console.log("inside handler of zerion");
        const response = await zerionProvider.get(runtime, message);
        console.log("ZERION portfolioAPI response: ", response);
        if (!response.success || !response.data) {
            return false;
        }

        console.log("ZERION API response: ", response);

        // Add type guard to ensure we have PortfolioData
        if (!isPortfolioData(response.data)) {
            return false;
        }

        // format response into a message string;
        const formattedResponse = formatPortfolioData(response.data);

        if (callback) {
            console.log("sending response to callback");
            callback({
                text: formattedResponse,
                content: {
                    ...response.data
                }
            })
        }
        return true;
    }
}

// Add type guard function
function isPortfolioData(data: PortfolioData | PositionData): data is PortfolioData {
    return (
        'chainDistribution' in data &&
        'positionTypes' in data &&
        'changes' in data
    );
}