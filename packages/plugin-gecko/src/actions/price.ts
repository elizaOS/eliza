import {
    Action,
    elizaLogger,
    IAgentRuntime,
    Memory,
    HandlerCallback,
    State,
    composeContext,
    generateMessageResponse,
    ModelClass,
} from "@elizaos/core";

import { coingeckoProvider } from "../providers/coins";
import type { PriceResponse } from "../types.ts";

export const priceTemplate = `From previous sentence extract only the cryptocurrency name, symbol, or ticker being asked about.
Do not include words like "token", "coin", "price",
unless it's part of the name like in "bitcoin" there is a "coin".
Respond with a JSON markdown block containing only the extracted value:

\`\`\`json
{
"coinName": string | null
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

export const getPriceAction: Action = {
    name: "GET_COIN_PRICE",
    description:
        "Get the current USD price and market cap for a specified cryptocurrency using CoinGecko API.",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        elizaLogger.log("Validating runtime for GET_COIN_PRICE...");
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
        elizaLogger.log("Starting GET_COIN_PRICE handler...");

        try {
            const apiKey =
                runtime.getSetting("COINGECKO_API_KEY") ??
                process.env.COINGECKO_API_KEY;

            // Get the list of supported coins first
            const { supportedCoins } = await coingeckoProvider.get(
                runtime,
                _message
            );

            // Update the state with current inputs
            if (!state) {
                state = (await runtime.composeState(_message)) as State;
            } else {
                state = await runtime.updateRecentMessageState(state);
            }

            const context = `${_message.content.text}\n${priceTemplate}`;

            const priceRequest = await generateMessageResponse({
                runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            priceRequest.coinName;
            const result = priceRequest.coinName as string;

            if (!result) {
                callback(
                    {
                        text: "Invalid coin name specified.",
                    },
                    []
                );
                return;
            }

            const searchTerm = result.toLowerCase();

            // Find all matching coins in our supported coins list
            const matchingCoins = supportedCoins.filter(
                (c) =>
                    c.id.includes(searchTerm) ||
                    c.symbol.includes(searchTerm) ||
                    c.name.toLowerCase().includes(searchTerm)
            );

            if (matchingCoins.length === 0) {
                callback(
                    {
                        text: `Could not find coin "${searchTerm}" in CoinGecko's supported coins list.`,
                    },
                    []
                );
                return;
            }

            // If we have multiple matches, we'll need to fetch prices for all of them
            const pricePromises = matchingCoins.map(async (coin) => {
                const priceUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${coin.id}&vs_currencies=usd&include_market_cap=true`;
                const priceResponse = await fetch(priceUrl, {
                    method: "GET",
                    headers: {
                        accept: "application/json",
                        "x-cg-demo-api-key": apiKey,
                    },
                });

                if (!priceResponse.ok) {
                    return null;
                }

                const priceData: PriceResponse = await priceResponse.json();
                return {
                    coin,
                    price: priceData[coin.id]?.usd,
                    marketCap: priceData[coin.id]?.usd_market_cap,
                };
            });

            const priceResults = await Promise.all(pricePromises);

            // Filter out any failed requests and sort by market cap
            const validResults = priceResults
                .filter(
                    (result): result is NonNullable<typeof result> =>
                        result !== null &&
                        typeof result.price === "number" &&
                        typeof result.marketCap === "number"
                )
                .sort((a, b) => b.marketCap - a.marketCap);

            if (validResults.length === 0) {
                callback(
                    {
                        text: `Unable to fetch price data for ${searchTerm}.`,
                    },
                    []
                );
                return;
            }

            // Use the coin with the highest market cap
            const { coin, price, marketCap } = validResults[0];
            const formattedMarketCap = formatMarketCap(marketCap);

            // If there were multiple matches, add a note about the selection
            const multipleMatchesNote =
                validResults.length > 1
                    ? `\n(Selected based on highest market cap among ${validResults.length} matching coins)`
                    : "";

            elizaLogger.log(multipleMatchesNote);

            callback(
                {
                    text: `Current price for ${coin.name} (${coin.symbol.toUpperCase()}): ${price.toFixed(2)} USD\nMarket Cap: ${formattedMarketCap} USD`,
                },
                []
            );
        } catch (error) {
            elizaLogger.error("Error during price lookup:", error);
            callback(
                {
                    text: "Failed to fetch coin price. Please check the logs for more details.",
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
                    text: "What's the current price of Bitcoin?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Current price for Bitcoin (BTC): $45,123.45 USD\nMarket Cap: $876.5 billion USD",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me ETH price",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Current price for Ethereum (ETH): $2,456.78 USD\nMarket Cap: $298.4 billion USD",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me price for Pendle Token",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Current price for Pendle (PENDLE): $7.89 USD\nMarket Cap: $156.3 million USD",
                },
            },
        ],
    ],
    similes: [
        "GET_COIN_PRICE",
        "FETCH_CRYPTO_PRICE",
        "CHECK_TOKEN_PRICE",
        "LOOKUP_COIN_VALUE",
        "GET_TOKEN_PRICE",
        "CHECK_CRYPTO_PRICE",
        "FETCH_TOKEN_VALUE",
    ],
};
