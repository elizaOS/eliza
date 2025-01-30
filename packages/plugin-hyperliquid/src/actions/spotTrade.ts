import {
    type Action,
    type ActionExample,
    type IAgentRuntime,
    type Memory,
    type State,
    type HandlerCallback,
    composeContext,
    elizaLogger,
    generateObjectDeprecated,
    ModelClass,
} from "@elizaos/core";
import { Hyperliquid } from "hyperliquid";
import {
    SpotOrderSchema,
    HyperliquidError,
    PRICE_VALIDATION,
} from "../types.js";
import { priceCheckTemplate, spotTradeTemplate } from "../templates.js";

export const spotTrade: Action = {
    name: "SPOT_TRADE",
    similes: ["SPOT_ORDER", "SPOT_BUY", "SPOT_SELL"],
    description: "Place a spot trade order on Hyperliquid",
    validate: async (runtime: IAgentRuntime) => {
        return !!runtime.getSetting("HYPERLIQUID_PRIVATE_KEY");
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: Record<string, unknown>,
        callback?: HandlerCallback
    ) => {
        try {
            // Initialize or update state
            const currentState = !state
                ? await runtime.composeState(message)
                : await runtime.updateRecentMessageState(state);

            const context = composeContext({
                state: currentState,
                template: priceCheckTemplate,
            });

            const content = await generateObjectDeprecated({
                runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            if (!content) {
                throw new HyperliquidError(
                    "Could not parse trading parameters from conversation"
                );
            }

            elizaLogger.info(
                "Raw content from LLM:",
                JSON.stringify(content, null, 2)
            );

            // Validate order parameters
            const validatedOrder = SpotOrderSchema.parse(content);
            elizaLogger.info("Validated order:", validatedOrder);

            // Initialize SDK
            const sdk = new Hyperliquid({
                privateKey: runtime.getSetting("HYPERLIQUID_PRIVATE_KEY"),
                testnet: runtime.getSetting("HYPERLIQUID_TESTNET") === "true",
                enableWs: false,
            });
            await sdk.connect();

            // Get market data
            const [meta, assetCtxs] =
                await sdk.info.spot.getSpotMetaAndAssetCtxs();

            // Find token and market
            const tokenIndex = meta.tokens.findIndex(
                (token) =>
                    token.name.toUpperCase() ===
                    validatedOrder.coin.toUpperCase()
            );
            if (tokenIndex === -1) {
                throw new HyperliquidError(
                    `Could not find token ${validatedOrder.coin}`
                );
            }
            const tokenInfo = meta.tokens[tokenIndex];
            elizaLogger.info("Found token:", tokenInfo.name);

            const marketIndex = assetCtxs.findIndex(
                (ctx) => ctx.coin === `${validatedOrder.coin}-SPOT`
            );
            if (marketIndex === -1) {
                throw new HyperliquidError(
                    `Could not find market for ${validatedOrder.coin}`
                );
            }
            const marketCtx = assetCtxs[marketIndex];
            if (!marketCtx || !marketCtx.midPx) {
                throw new HyperliquidError(
                    `Could not get market price for ${validatedOrder.coin}`
                );
            }

            // Calculate prices
            const midPrice = Number(marketCtx.midPx);
            const isMarketOrder = !validatedOrder.limit_px;
            let finalPrice: number;

            if (isMarketOrder) {
                // For market orders, use current price with slippage
                const slippage = PRICE_VALIDATION.SLIPPAGE;
                finalPrice = validatedOrder.is_buy
                    ? midPrice * (1 + slippage)
                    : midPrice * (1 - slippage);

                // Validate market order price
                if (
                    finalPrice <
                        midPrice * PRICE_VALIDATION.MARKET_ORDER.MIN_RATIO ||
                    finalPrice >
                        midPrice * PRICE_VALIDATION.MARKET_ORDER.MAX_RATIO
                ) {
                    throw new HyperliquidError(
                        `Market order price (${finalPrice.toFixed(2)} USDC) is too far from market price (${midPrice.toFixed(2)} USDC). This might be due to low liquidity.`
                    );
                }
            } else {
                // For limit orders
                finalPrice = validatedOrder.limit_px;

                // Validate limit order price is optimal
                if (validatedOrder.is_buy && finalPrice > midPrice) {
                    throw new HyperliquidError(
                        `Cannot place buy limit order at ${finalPrice.toFixed(2)} USDC because it's above market price (${midPrice.toFixed(2)} USDC). To execute immediately, use a market order. For a limit order, set a price below ${midPrice.toFixed(2)} USDC.`
                    );
                } else if (!validatedOrder.is_buy && finalPrice < midPrice) {
                    throw new HyperliquidError(
                        `Cannot place sell limit order at ${finalPrice.toFixed(2)} USDC because it's below market price (${midPrice.toFixed(2)} USDC). To execute immediately, use a market order. For a limit order, set a price above ${midPrice.toFixed(2)} USDC.`
                    );
                }

                // Log warning if price is very different from market
                if (
                    finalPrice <
                        midPrice *
                            PRICE_VALIDATION.LIMIT_ORDER.WARNING_MIN_RATIO ||
                    finalPrice >
                        midPrice *
                            PRICE_VALIDATION.LIMIT_ORDER.WARNING_MAX_RATIO
                ) {
                    elizaLogger.warn(
                        `Limit price (${finalPrice.toFixed(2)} USDC) is very different from market price (${midPrice.toFixed(2)} USDC). Make sure this is intentional.`,
                        {
                            finalPrice,
                            midPrice,
                            ratio: finalPrice / midPrice,
                        }
                    );
                }
            }

            // Prepare and place order
            const rounded_px = Number(finalPrice.toFixed(tokenInfo.szDecimals));
            const orderRequest = {
                coin: `${validatedOrder.coin}-SPOT`,
                asset: 10000 + marketIndex,
                is_buy: validatedOrder.is_buy,
                sz: validatedOrder.sz,
                limit_px: rounded_px,
                reduce_only: false,
                order_type: isMarketOrder
                    ? { market: {} }
                    : { limit: { tif: "Gtc" as const } },
            };

            elizaLogger.info("Placing order:", orderRequest);
            const result = await sdk.exchange.placeOrder(orderRequest);

            // Check if order was rejected
            if (
                result.status === "ok" &&
                result.response?.type === "order" &&
                result.response.data?.statuses?.[0]?.error
            ) {
                throw new HyperliquidError(
                    result.response.data.statuses[0].error
                );
            }

            // Send success callback
            if (callback) {
                const action = validatedOrder.is_buy ? "buy" : "sell";
                const executionPrice =
                    result.response?.data?.statuses?.[0]?.px || rounded_px;
                callback({
                    text: `Successfully placed ${isMarketOrder ? "a market" : "a limit"} order to ${action} ${validatedOrder.sz} ${validatedOrder.coin} at ${executionPrice}`,
                    content: result,
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error placing spot order:", error);
            if (callback) {
                callback({
                    text: `Error placing spot order: ${error.message}`,
                    content: { error: error.message },
                });
            }
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Buy 0.1 HYPE at 20 USDC",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll place a spot buy order for 0.1 HYPE at 20 USDC.",
                    action: "SPOT_TRADE",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully placed a limit order to buy 0.1 HYPE at 20 USDC",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Sell 2 HYPE at 21 USDC",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll place a spot sell order for 2 HYPE at 21 USDC.",
                    action: "SPOT_TRADE",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully placed a limit order to sell 2 HYPE at 21 USDC",
                },
            },
        ],
    ] as ActionExample[][],
};

export default spotTrade;
