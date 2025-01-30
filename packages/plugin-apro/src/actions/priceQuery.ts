import { Action, composeContext, elizaLogger, generateObject, HandlerCallback, IAgentRuntime, Memory, ModelClass, State } from "@elizaos/core";
import { priceQueryTemplate } from "../templates";
import { isPriceQueryParams, PriceData, PriceQueryParams, PriceQueryParamsSchema } from "../types";

async function fetchPriceData(pair: string) {
    const response = await fetch(`https://live-api.apro.com/api/live-stream/reports?pair=${pair}`);
    const { result } = await response.json();
    return result as PriceData[];
}

export const priceQuery: Action = {
    name: "PRICE_QUERY",
    similes: [
        'PRICE_FETCH',
    ],
    description: "Call remote API to fetch price data for a given pair.",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        _options?: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        // Generate price query params
        let priceQueryParams: PriceQueryParams;
        try {
            const response = await generateObject({
                runtime,
                context: composeContext({
                    state,
                    template: priceQueryTemplate,
                }),
                modelClass: ModelClass.LARGE,
                schema: PriceQueryParamsSchema,
            });
            priceQueryParams = response.object as PriceQueryParams;
            elizaLogger.info('The price query params received:', priceQueryParams);
        } catch (error: any) {
            elizaLogger.error('Failed to generate price query params:', error);
            callback({
                text: 'Failed to generate price query params. Please provide valid input.',
            });
            return;
        }

        // Validate price query params
        if (!isPriceQueryParams(priceQueryParams)) {
            elizaLogger.error('Invalid price query params:', priceQueryParams);
            callback({
                text: 'Invalid price query params. Please provide valid input.',
            });
            return;
        }

        // Fetch price data
        try {
            const { pair } = priceQueryParams;
            const priceData = await fetchPriceData(pair);
            elizaLogger.info('The Price data received:', priceData);

            if (!priceData || priceData.length === 0) {
                elizaLogger.error('No price data found for pair:', pair);
                callback({
                    text: `No price data found for pair ${pair}.`,
                });
                return;
            }

            let priceDataString = priceData.map((data) => {
                return `Feed ID: ${data.feedId}\nBid Price: ${data.bidPrice}\nMid Price: ${data.midPrice}\nAsk Price: ${data.askPrice}\nTimestamp: ${data.timestamp}`;
            }).join('\n\n');
            callback({
                text: `Price data for pair ${pair}: \n${priceDataString}`,
            });
        } catch (error: any) {
            elizaLogger.error(`Error fetching price data, error: `, error);
            callback(
                {
                    text: 'Error fetching price data, error: ' + error.message,
                }
            )
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you fetch price data for pair BTC/USD?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll fetch price data for pair BTC/USD.",
                    action: 'PRICE_QUERY',
                },
            }
        ],
    ],
}