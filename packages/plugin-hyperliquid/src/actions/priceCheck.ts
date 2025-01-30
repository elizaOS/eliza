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
import { HyperliquidError } from "../types.js";
import { priceCheckTemplate } from "../templates.js";

export const priceCheck: Action = {
    name: "PRICE_CHECK",
    similes: ["CHECK_PRICE", "GET_PRICE", "PRICE", "CURRENT_PRICE"],
    description: "Get current price for a token on Hyperliquid",
    validate: async () => true, // Public endpoint
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

            if (!content?.symbol) {
                throw new HyperliquidError(
                    "Could not determine which token price to check"
                );
            }

            elizaLogger.info("Checking price for token:", content.symbol);

            // Initialize SDK
            const sdk = new Hyperliquid({
                enableWs: false,
            });
            await sdk.connect();

            // Get market data
            const [meta, assetCtxs] =
                await sdk.info.spot.getSpotMetaAndAssetCtxs();

            // Find token and market
            const tokenIndex = meta.tokens.findIndex(
                (token) =>
                    token.name.toUpperCase() === content.symbol.toUpperCase()
            );
            if (tokenIndex === -1) {
                throw new HyperliquidError(
                    `Could not find token ${content.symbol}`
                );
            }

            const marketIndex = assetCtxs.findIndex(
                (ctx) => ctx.coin === `${content.symbol}-SPOT`
            );
            if (marketIndex === -1) {
                throw new HyperliquidError(
                    `Could not find market for ${content.symbol}`
                );
            }

            const marketCtx = assetCtxs[marketIndex];
            if (!marketCtx || !marketCtx.midPx) {
                throw new HyperliquidError(
                    `Could not get market price for ${content.symbol}`
                );
            }

            const price = Number(marketCtx.midPx);
            const dayChange = (
                ((price - Number(marketCtx.prevDayPx)) /
                    Number(marketCtx.prevDayPx)) *
                100
            ).toFixed(2);
            const volume = Number(marketCtx.dayNtlVlm).toFixed(2);

            if (callback) {
                callback({
                    text: `${content.symbol} price: ${price.toFixed(2)} USDC (24h change: ${dayChange}%, volume: ${volume} USDC)`,
                    content: {
                        symbol: content.symbol,
                        price: price,
                        dayChange: dayChange,
                        volume: volume,
                    },
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error checking price:", error);
            if (callback) {
                callback({
                    text: `Error checking price: ${error.message}`,
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
                    text: "What's the current price of PIP?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll check the current PIP price for you.",
                    action: "PRICE_CHECK",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "PIP price: 19.73 USDC (24h change: -1.82%, volume: 1053445.75 USDC)",
                },
            },
        ],
    ] as ActionExample[][],
};

export default priceCheck;
