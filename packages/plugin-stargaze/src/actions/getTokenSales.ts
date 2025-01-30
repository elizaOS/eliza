import {
    composeContext,
    type Content,
    elizaLogger,
    generateObjectDeprecated,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    type Action,
} from "@elizaos/core";
import axios from "axios";
import { debugLog } from "../utils/debug";
import { validateStargazeConfig } from "../environment";
import type { TokenSale, TokenSalesResponse } from "../types";

const getTokenSalesTemplate = `Given the message, extract the collection address for fetching Stargaze sales data.

Format the response as a JSON object with these fields:
- collectionAddr: the collection address or name (required)
- limit: number of sales to fetch (default to 5)

Example response:
\`\`\`json
{
    "collectionAddr": "ammelia",
    "limit": 5
}
\`\`\`

{{recentMessages}}

Extract the collection information from the above messages and respond with the appropriate JSON.`;

export const TOKEN_SALES_QUERY = `
query TokenSales($collectionAddr: String!, $limit: Int) {
    tokenSales(
        filterByCollectionAddrs: [$collectionAddr]
        limit: $limit
        sortBy: USD_PRICE_DESC
    ) {
        tokenSales {
            id
            token {
                tokenId
                name
                media {
                    url
                }
            }
            price
            priceUsd
            date
            saleDenomSymbol
            saleType
            buyer {
                address
            }
            seller {
                address
            }
        }
    }
}`;

export interface GetTokenSalesContent extends Content {
    collectionAddr: string;
    limit: number;
}

export default {
    name: "GET_TOKEN_SALES",
    similes: ["CHECK_SALES", "RECENT_SALES"],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        elizaLogger.log("🔄 Validating Stargaze configuration...");
        try {
            const config = await validateStargazeConfig(runtime);
            debugLog.validation(config);
            return true;
        } catch (error) {
            debugLog.error(error);
            return false;
        }
    },
    description: "Get recent sales data for a Stargaze collection",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("🚀 Starting Stargaze GET_TOKEN_SALES handler...");

        if (!state) {
            elizaLogger.log("Creating new state...");
            state = (await runtime.composeState(message)) as State;
        } else {
            elizaLogger.log("Updating existing state...");
            state = await runtime.updateRecentMessageState(state);
        }

        try {
            elizaLogger.log("Composing sales context...");
            const salesContext = composeContext({
                state,
                template: getTokenSalesTemplate,
            });

            elizaLogger.log("Generating content from context...");
            const content = (await generateObjectDeprecated({
                runtime,
                context: salesContext,
                modelClass: ModelClass.LARGE,
            })) as unknown as GetTokenSalesContent;

            if (!content || !content.collectionAddr) {
                throw new Error("Invalid or missing collection address in parsed content");
            }

            debugLog.validation(content);

            const config = await validateStargazeConfig(runtime);

            const requestData = {
                query: TOKEN_SALES_QUERY,
                variables: {
                    collectionAddr: content.collectionAddr,
                    limit: content.limit || 5,
                },
            };

            debugLog.request('POST', config.STARGAZE_ENDPOINT, requestData);

            const response = await axios.post<TokenSalesResponse>(
                config.STARGAZE_ENDPOINT,
                requestData,
                {
                    headers: {
                        'Content-Type': 'application/json',
                    }
                }
            );

            debugLog.response(response);

            const sales = response.data?.data?.tokenSales?.tokenSales;
            if (!sales?.length) {
                throw new Error("No sales found for collection");
            }

            // Format numeric values
            const formatPrice = (price: number, symbol: string) =>
                `${Number(price).toLocaleString(undefined, {
                    maximumFractionDigits: 2
                })} ${symbol}`;

            // Format date to local string
            const formatDate = (dateStr: string) => {
                try {
                    return new Date(dateStr).toLocaleString();
                } catch {
                    return dateStr;
                }
            };

            if (callback) {
                const salesText = sales.map((sale: TokenSale) =>
                    `• ${sale.token.name} (ID: ${sale.token.tokenId})
    Price: ${formatPrice(sale.price, sale.saleDenomSymbol)} ($${sale.priceUsd.toFixed(2)})
    Date: ${formatDate(sale.date)}
    Type: ${sale.saleType}
    Seller: ${sale.seller.address}
    Buyer: ${sale.buyer.address}`
                ).join('\n\n');

                callback({
                    text: `Recent sales for ${content.collectionAddr}:\n\n${salesText}`,
                    content: {
                        collection: content.collectionAddr,
                        sales: sales
                    },
                });
            }

            return true;
        } catch (error) {
            debugLog.error(error);
            if (callback) {
                callback({
                    text: `Error fetching sales data: ${error instanceof Error ? error.message : 'Unknown error'}`,
                    content: { error: error instanceof Error ? error.message : 'Unknown error' },
                });
            }
            return false;
        }
    },
    examples: [[
        {
            user: "{{user1}}",
            content: {
                text: "Show me recent sales from collection ammelia",
            },
        },
        {
            user: "{{agent}}",
            content: {
                text: "I'll check the recent sales for the ammelia collection...",
                action: "GET_TOKEN_SALES",
            },
        },
        {
            user: "{{agent}}",
            content: {
                text: "Here are the recent sales data for ammelia collection:\n• NFT #123 - Sold for 100 STARS ($5.20)\n• NFT #124 - Sold for 95 STARS ($4.95)",
            },
        }
    ]],
} as Action;