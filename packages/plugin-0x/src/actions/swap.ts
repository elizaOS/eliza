import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
    elizaLogger,
    MemoryManager,
} from "@elizaos/core";
import { Hex, numberToHex, concat } from "viem";
import { CHAIN_EXPLORERS, ZX_MEMORY } from "../constants";
import { getWalletClient } from "../hooks.ts/useGetWalletClient";
import { Chains, Quote } from "../types";
import { getPriceInquiry } from "./getIndicativePrice";
import { getQuoteObj } from "./getQuote";

export const swap: Action = {
    name: "EXECUTE_SWAP_0X",
    similes: [
        "SWAP_TOKENS_0X",
        "TOKEN_SWAP_0X",
        "TRADE_TOKENS_0X",
        "EXCHANGE_TOKENS_0X",
    ],
    suppressInitialMessage: true,
    description: "Execute a token swap using 0x protocol",
    validate: async (runtime: IAgentRuntime) => {
        return (
            !!runtime.getSetting("ZERO_EX_API_KEY")
        );
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: Record<string, unknown>,
        callback: HandlerCallback
    ) => {
        const latestQuote = await retrieveLatestQuote(runtime, message);
        if (!latestQuote) {
            callback({
                text: "Please provide me the details of the swap. E.g. convert 000.1 Weth to USDC on Ethereum chain",
            });
            return;
        }

        const { quote, chainId } = latestQuote;

        try {
            const client = getWalletClient('', chainId); // 1 for mainnet, or pass chainId

            // 1. Handle Permit2 signature
            let signature: Hex | undefined;
            if (quote.permit2?.eip712) {
                signature = await client.signTypedData({
                    account: client.account,
                    ...quote.permit2.eip712,
                });

                if (signature && quote.transaction?.data) {
                    const sigLengthHex = numberToHex(signature.length, {
                        size: 32,
                    }) as Hex;
                    quote.transaction.data = concat([
                        quote.transaction.data as Hex,
                        sigLengthHex,
                        signature,
                    ]);
                }
            }

            const nonce = await client.getTransactionCount({
                address: (client.account as { address: `0x${string}` }).address,
            });

            const txHash = await client.sendTransaction({
                account: client.account,
                chain: client.chain,
                gas: quote?.transaction.gas
                    ? BigInt(quote?.transaction.gas)
                    : undefined,
                to: quote?.transaction.to as `0x${string}`,
                data: quote.transaction.data as `0x${string}`,
                value: BigInt(quote.transaction.value),
                gasPrice: quote?.transaction.gasPrice
                    ? BigInt(quote?.transaction.gasPrice)
                    : undefined,
                nonce: nonce,
                kzg: undefined,
            });

            // Wait for transaction confirmation
            const receipt = await client.waitForTransactionReceipt({
                hash: txHash,
            });

            if (receipt.status === "success") {
                callback({
                    text: `✅ Swap executed successfully!\nView on Explorer: ${CHAIN_EXPLORERS[chainId]}/tx/${txHash}`,
                    content: { hash: txHash, status: "success" },
                });
                return true;
            } else {
                callback({
                    text: `❌ Swap failed! Check transaction: ${CHAIN_EXPLORERS[chainId]}/tx/${txHash}`,
                    content: { hash: txHash, status: "failed" },
                });
                return false;
            }
        } catch (error) {
            elizaLogger.error("Swap execution failed:", error);
            callback({
                text: `❌ Failed to execute swap: ${error.message || error}`,
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
                    text: "I want to swap 1 ETH for USDC",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Let me get you a quote for that swap.",
                    action: "GET_INDICATE_PRICE_0X",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Get the quote for 1 ETH for USDC on Ethereum chain",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Let me get you the quotefor 1 ETH for USDC on Ethereum chain",
                    action: "GET_QUOTE_0X",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "execute the swap",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Let me execute the swap for you.",
                    action: "EXECUTE_SWAP_0X",
                },
            },
        ],
    ],
};

export const retrieveLatestQuote = async (
    runtime: IAgentRuntime,
    message: Memory
): Promise<Quote | null> => {
    const memoryManager = new MemoryManager({
        runtime,
        tableName: ZX_MEMORY.quote.tableName,
    });

    try {
        const memories = await memoryManager.getMemories({
            roomId: message.roomId,
            count: 1,
            start: 0,
            end: Date.now(),
        });

        if (memories?.[0]) {
            return JSON.parse(memories[0].content.text) as Quote;
        }
        return null;
    } catch (error) {
        elizaLogger.error(`Failed to retrieve quote: ${error.message}`);
        return null;
    }
};

export const tokenSwap = async (runtime: IAgentRuntime, quantity: number, fromCurrency: string, toCurrency: string, address: string, privateKey: string, chain: string) => {
    let priceInquiry = null;
    try {
        // get indicative price
        priceInquiry = await getPriceInquiry(runtime, fromCurrency, quantity, toCurrency, chain);
        elizaLogger.info("priceInquiry ", JSON.stringify(priceInquiry))
    } catch (error) {
        elizaLogger.error("Error during price inquiry", error.message);
        return null;
    }
    if (!priceInquiry) {
        elizaLogger.error("Price inquiry is null");
        return null;
    }
        const chainId = Chains.base;
        elizaLogger.info("chainId ", chainId)
        let quote = null;
        try {
            // get latest quote
            elizaLogger.info("Getting quote for swap", JSON.stringify(priceInquiry));
            quote = await getQuoteObj(runtime, priceInquiry, address);
            elizaLogger.info("quotes ", JSON.stringify(quote))
        } catch (error) {
            elizaLogger.error("Error during quote retrieval", error.message);
            return null;
        }
        if (!quote) {
            elizaLogger.error("Quote is null");
            return null;
        }
        try {
            const client = getWalletClient(privateKey, chainId);
            // add a balance check for gas and sell token 
            const enoughGasBalance = true 
            const enoughSellTokenBalance = true 
            if (!enoughGasBalance || !enoughSellTokenBalance) {
                elizaLogger.error("Not enough balance for gas or sell token");
                return null;
            }
            // 1. Handle Permit2 signature
            let signature: Hex | undefined;
            if (quote.permit2?.eip712) {
                signature = await client.signTypedData({
                    account: client.account,
                    ...quote.permit2.eip712,
                });

                if (signature && quote.transaction?.data) {
                    const sigLengthHex = numberToHex(signature.length, {
                        size: 32,
                    }) as Hex;
                    quote.transaction.data = concat([
                        quote.transaction.data as Hex,
                        sigLengthHex,
                        signature,
                    ]);
                }
            }

            const nonce = await client.getTransactionCount({
                address: (client.account as { address: `0x${string}` }).address,
            });
            elizaLogger.info("nonce ", nonce)
            const txHash = await client.sendTransaction({
                account: client.account,
                chain: client.chain,
                gas: !!quote?.transaction.gas
                    ? BigInt(quote?.transaction.gas)
                    : undefined,
                to: quote?.transaction.to as `0x${string}`,
                data: quote.transaction.data as `0x${string}`,
                value: BigInt(quote.transaction.value),
                gasPrice: !!quote?.transaction.gasPrice
                    ? BigInt(quote?.transaction.gasPrice)
                    : undefined,
                nonce: nonce,
                kzg: undefined,
            });
            elizaLogger.info("txHash", txHash)
            // Wait for transaction confirmation
            const receipt = await client.waitForTransactionReceipt({
                hash: txHash,
            });
            elizaLogger.info("receipt ", receipt)
            if (receipt.status === "success") {
                return txHash;
            } else {
                return null;
            }
        } catch (error) {
            elizaLogger.error("Error during transaction process:", error.message);
            return null;
        }
}
