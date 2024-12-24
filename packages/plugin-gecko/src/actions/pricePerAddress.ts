import {
    Action,
    elizaLogger,
    IAgentRuntime,
    Memory,
    HandlerCallback,
    State,
    composeContext,
    generateObject,
    ModelClass,
} from "@elizaos/core";

import { AddressLookupSchema, AddressLookupContent } from "../types.ts";

// Template for extracting chain and address
export const addressTemplate = `Use JUST the last message from recent messages
{{recentMessages}}

Extract the blockchain name/chain ID and token address being asked about.
Normalize chain names: ethereum, polygon, solana, base, etc.
Token address should be the full address string.

Respond with a JSON markdown block containing the extracted values:

\`\`\`json
{
"chainId": string,
"tokenAddress": string
}
\`\`\`
`;

function formatMarketCap(marketCap: number): string {
    if (marketCap >= 1_000_000_000) {
        return `${(marketCap / 1_000_000_000).toFixed(1)} billion`;
    } else if (marketCap >= 1_000_000) {
        return `${(marketCap / 1_000_000).toFixed(1)} million`;
    } else if (marketCap >= 1_000) {
        return `${(marketCap / 1_000).toFixed(1)} thousand`;
    }
    return marketCap.toString();
}

export const getPriceByAddressAction: Action = {
    name: "GET_TOKEN_PRICE_BY_ADDRESS",
    description:
        "Get the current USD price for a token using its blockchain address via CoinGecko API.",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        elizaLogger.log("Validating runtime for GET_TOKEN_PRICE_BY_ADDRESS...");
        return !!(
            runtime.getSetting("COINGECKO_API_KEY") ||
            process.env.COINGECKO_API_KEY
        );
    },
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        state: State,
        _options: any,
        callback: HandlerCallback
    ) => {
        elizaLogger.log("Starting GET_TOKEN_PRICE_BY_ADDRESS handler...");

        try {
            const apiKey =
                runtime.getSetting("COINGECKO_API_KEY") ??
                process.env.COINGECKO_API_KEY;

            // Initialize or update state
            if (!state) {
                state = (await runtime.composeState(_message)) as State;
            } else {
                state = await runtime.updateRecentMessageState(state);
            }

            // Generate the address lookup from the message context
            const context = composeContext({
                state,
                template: addressTemplate,
            });

            const addressRequest = await generateObject({
                runtime,
                context,
                modelClass: ModelClass.SMALL,
                schema: AddressLookupSchema,
            });

            const result = AddressLookupSchema.safeParse(addressRequest.object);

            if (!result.success) {
                callback(
                    {
                        text: "Invalid chain ID or token address specified.",
                    },
                    []
                );
                return;
            }

            const { chainId: rawChainId, tokenAddress } = result.data;
            // Ensure chain ID is lowercase
            const chainId = rawChainId.toLowerCase();

            // First, fetch token metadata to get the name
            const metadataUrl = `https://api.coingecko.com/api/v3/coins/${chainId}/contract/${tokenAddress}`;
            const metadataResponse = await fetch(metadataUrl, {
                method: "GET",
                headers: {
                    accept: "application/json",
                    "x-cg-demo-api-key": apiKey,
                },
            });

            let tokenName = null;
            let tokenSymbol = null;

            if (metadataResponse.ok) {
                const metadata = await metadataResponse.json();
                tokenName = metadata.name;
                tokenSymbol = metadata.symbol?.toUpperCase();
            }

            // Format the URL for token price lookup
            const url = `https://api.coingecko.com/api/v3/simple/token_price/${chainId}?contract_addresses=${tokenAddress}&vs_currencies=usd&include_market_cap=true`;

            const priceResponse = await fetch(url, {
                method: "GET",
                headers: {
                    accept: "application/json",
                    "x-cg-demo-api-key": apiKey,
                },
            });

            if (!priceResponse.ok) {
                throw new Error(`HTTP error! status: ${priceResponse.status}`);
            }

            const priceData = await priceResponse.json();

            // Try to find the token data regardless of case
            let tokenData =
                priceData[tokenAddress] ||
                priceData[tokenAddress.toLowerCase()] ||
                priceData[tokenAddress.toUpperCase()];

            // If still not found, try to find by searching through keys
            if (!tokenData) {
                const priceDataKeys = Object.keys(priceData);
                const matchingKey = priceDataKeys.find(
                    (key) => key.toLowerCase() === tokenAddress.toLowerCase()
                );
                if (matchingKey) {
                    tokenData = priceData[matchingKey];
                }
            }

            if (!tokenData || !tokenData.usd) {
                callback(
                    {
                        text: `Unable to fetch price for token address ${tokenAddress} on ${chainId}.`,
                    },
                    []
                );
                return;
            }

            const price = tokenData.usd;
            const marketCap = tokenData.usd_market_cap;
            const formattedMarketCap = marketCap
                ? `\nMarket Cap: $${formatMarketCap(marketCap)} USD`
                : "";

            // Prepare token identifier string
            const tokenIdentifier =
                tokenName && tokenSymbol
                    ? `${tokenName} (${tokenSymbol})`
                    : `token`;

            callback(
                {
                    text: `Current price for ${tokenIdentifier}\nAddress: ${tokenAddress}\nChain: ${chainId}\nPrice: ${price.toFixed(6)} USD${formattedMarketCap}`,
                },
                []
            );
        } catch (error) {
            elizaLogger.error("Error during price lookup:", error);
            callback(
                {
                    text: "Failed to fetch token price. Please check the logs for more details.",
                },
                []
            );
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What's the price of token 0x4f9fd6be4a90f2620860d680c0d4d5fb53d1a825 on ethereum?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Current price for Compound (COMP)\nAddress: 0x4f9fd6be4a90f2620860d680c0d4d5fb53d1a825\nChain: ethereum\nPrice: $1.234567 USD\nMarket Cap: $45.6 million USD",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me the price for 0x2260fac5e5542a773aa44fbcfedf7c193bc2c599 on ethereum",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Current price for Wrapped Bitcoin (WBTC)\nAddress: 0x2260fac5e5542a773aa44fbcfedf7c193bc2c599\nChain: ethereum\nPrice: $42000.123456 USD\nMarket Cap: $2.1 billion USD",
                },
            },
        ],
    ],
    similes: [
        "GET_TOKEN_PRICE_BY_ADDRESS",
        "FETCH_TOKEN_PRICE_BY_ADDRESS",
        "CHECK_TOKEN_PRICE_BY_ADDRESS",
        "LOOKUP_TOKEN_BY_ADDRESS",
    ],
};
