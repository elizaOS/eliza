import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
    elizaLogger,
    composeContext,
    ModelClass,
    generateObject,
    MemoryManager,
} from "@elizaos/core";
import { createClientV2 } from "@0x/swap-ts-sdk";
import { getIndicativePriceTemplate } from "../templates";
import { z } from "zod";
import { Chains, GetIndicativePriceResponse, PriceInquiry } from "../types";
import { parseUnits } from "viem";
import { CHAIN_NAMES, ZX_MEMORY } from "../constants";
import { EVMTokenRegistry } from "../EVMtokenRegistry";

export const IndicativePriceSchema = z.object({
    sellTokenSymbol: z.string().nullable(),
    sellAmount: z.number().nullable(),
    buyTokenSymbol: z.string().nullable(),
    chain: z.string().nullable(),
});

export interface IndicativePriceContent {
    sellTokenSymbol: string;
    sellAmount: number;
    buyTokenSymbol: string;
    chain: string;
}

export const getIndicativePrice: Action = {
    name: "GET_INDICATIVE_PRICE_0X",
    similes: [],
    suppressInitialMessage: true,
    description:
        "Get indicative price for a swap from 0x when user wants to convert their tokens",
    validate: async (runtime: IAgentRuntime) => {
        return !!runtime.getSetting("ZERO_EX_API_KEY");
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: Record<string, unknown>,
        callback: HandlerCallback
    ) => {
        const supportedChains = Object.keys(Chains).join(" | ");

        state = !state
            ? await runtime.composeState(message, { supportedChains })
            : await runtime.updateRecentMessageState(state);

        const context = composeContext({
            state,
            template: getIndicativePriceTemplate,
        });

        const content = await generateObject({
            runtime,
            context,
            modelClass: ModelClass.SMALL,
            schema: IndicativePriceSchema,
        });

        if (!isIndicativePriceContent(content.object)) {
            const missingFields = getMissingIndicativePriceContent(
                content.object
            );
            callback({
                text: `Need more information about the swap. Please provide me ${missingFields}`,
            });
            return;
        }

        const { sellTokenSymbol, sellAmount, buyTokenSymbol, chain } =
            content.object;

        // Convert chain string to chainId
        const chainId = Chains[chain.toLowerCase() as keyof typeof Chains];
        if (!chainId) {
            callback({
                text: `Unsupported chain: ${chain}. Supported chains are: ${Object.keys(
                    Chains
                )
                    .filter((k) => isNaN(Number(k)))
                    .join(", ")}`,
            });
            return;
        }

        const evmTokenRegistry = EVMTokenRegistry.getInstance();
        if (evmTokenRegistry.isChainSupported(chainId)) {
            await evmTokenRegistry.initializeChain(chainId);
        } else {
            callback({
                text: `Chain ${chain} is not supported for token swaps.`,
            });
            return;
        }

        const sellTokenMetadata = evmTokenRegistry.getTokenBySymbol(
            sellTokenSymbol,
            chainId
        );
        const buyTokenMetadata = evmTokenRegistry.getTokenBySymbol(
            buyTokenSymbol,
            chainId
        );

        if (!sellTokenMetadata || !buyTokenMetadata) {
            const missingTokens = [];
            if (!sellTokenMetadata) missingTokens.push(`'${sellTokenSymbol}'`);
            if (!buyTokenMetadata) missingTokens.push(`'${buyTokenSymbol}'`);

            callback({
                text: `Token${missingTokens.length > 1 ? 's' : ''} ${missingTokens.join(' and ')} not found on ${chain}. Please check the token symbols and chain.`,
            });
            return;
        }

        elizaLogger.info("Getting indicative price for:", {
            sellToken: sellTokenMetadata,
            buyToken: buyTokenMetadata,
            amount: sellAmount,
        });

        const zxClient = createClientV2({
            apiKey: runtime.getSetting("ZERO_EX_API_KEY"),
        });

        const sellAmountBaseUnits = parseUnits(
            sellAmount.toString(),
            sellTokenMetadata.decimals
        ).toString();

        try {
            const price = (await zxClient.swap.permit2.getPrice.query({
                sellAmount: sellAmountBaseUnits,
                sellToken: sellTokenMetadata.address,
                buyToken: buyTokenMetadata.address,
                chainId,
            })) as GetIndicativePriceResponse;

            // Format amounts to human-readable numbers
            const buyAmount =
                Number(price.buyAmount) /
                Math.pow(10, buyTokenMetadata.decimals);
            const sellAmount =
                Number(price.sellAmount) /
                Math.pow(10, sellTokenMetadata.decimals);

            await storePriceInquiryToMemory(runtime, message, {
                sellTokenObject: sellTokenMetadata,
                buyTokenObject: buyTokenMetadata,
                sellAmountBaseUnits,
                chainId,
                timestamp: new Date().toISOString(),
            });

            // Updated formatted response to include chain
            const formattedResponse = [
                `💱 Swap Details:`,
                `────────────────`,
                `📤 Sell: ${sellAmount.toFixed(4)} ${sellTokenMetadata.symbol}`,
                `📥 Buy: ${buyAmount.toFixed(4)} ${buyTokenMetadata.symbol}`,
                `📊 Rate: 1 ${sellTokenMetadata.symbol} = ${(buyAmount / sellAmount).toFixed(4)} ${buyTokenMetadata.symbol}`,
                `🔗 Chain: ${CHAIN_NAMES[chainId]}`,
                `────────────────`,
                `💫 Happy with the price? Type 'quote' to continue`,
            ].join("\n");

            callback({ text: formattedResponse });
            return true;
        } catch (error) {
            elizaLogger.error("Error getting price:", error);
            callback({
                text: `Error getting price: ${error.message || error}`,
                content: { error: error.message || String(error) },
            });
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What's the price of 2 ETH in USDC on Optimism?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Let me check the current exchange rate for ETH/USDC on Optimism.",
                    action: "GET_INDICATIVE_PRICE_0X",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I want to swap WETH for USDT on Arbitrum",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you check the price. How much WETH would you like to swap?",
                    action: "GET_INDICATIVE_PRICE_0X",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "5 WETH",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Let me get the indicative price for 5 WETH to USDT on Arbitrum.",
                    action: "GET_INDICATIVE_PRICE_0X",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Price check for 1000 USDC to WETH on Base",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll check the current exchange rate for 1000 USDC to WETH on Base network.",
                    action: "GET_INDICATIVE_PRICE_0X",
                },
            },
        ],
    ],
};

export const isIndicativePriceContent = (
    object: any
): object is IndicativePriceContent => {
    if (IndicativePriceSchema.safeParse(object).success) {
        return true;
    }
    return false;
};

export const getMissingIndicativePriceContent = (
    content: Partial<IndicativePriceContent>
): string => {
    const missingFields = [];

    if (typeof content.sellTokenSymbol !== "string")
        missingFields.push("sell token");
    if (typeof content.buyTokenSymbol !== "string")
        missingFields.push("buy token");
    if (typeof content.sellAmount !== "number")
        missingFields.push("sell amount");

    return missingFields.join(" and ");
};

export const storePriceInquiryToMemory = async (
    runtime: IAgentRuntime,
    message: Memory,
    priceInquiry: PriceInquiry
) => {
    const memory: Memory = {
        roomId: message.roomId,
        userId: message.userId,
        agentId: runtime.agentId,
        content: {
            text: JSON.stringify(priceInquiry),
            type: ZX_MEMORY.price.type,
        },
    };

    const memoryManager = new MemoryManager({
        runtime,
        tableName: ZX_MEMORY.price.tableName,
    });

    await memoryManager.createMemory(memory);
};
