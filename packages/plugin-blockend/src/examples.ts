import { ActionExample } from "@elizaos/core";

export const getTxnExecutionExamples: ActionExample[][] = [
    [
        {
            user: "{{user1}}",
            content: {
                text: "Swap 0.1 SOL for USDC...",
                fromAssetSymbol: "SOL",
                toAssetSymbol: "USDC",
                amount: 0.1,
                fromChainName: "solana",
                toChainName: "solana",
                slippage: 50,
            },
        },
        {
            user: "{{agent}}",
            content: {
                text: "Swapping 0.1 SOL for USDC...",
                action: "GET_TXN_EXECUTION",
            },
        },
        {
            user: "{{agent}}",
            content: {
                text: "Swap completed successfully! Transaction ID: ...",
            },
        },
    ],
    [
        {
            user: "{{user1}}",
            content: {
                text: "Bridge 1 sol on solana to eth on ethereum...",
                fromAssetSymbol: "SOL",
                toAssetSymbol: "ETH",
                amount: 1,
                fromChainName: "solana",
                toChainName: "ethereum",
                slippage: 50,
            },
        },
        {
            user: "{{agent}}",
            content: {
                text: "Bridging 1 sol on solana to eth on ethereum...",
                action: "GET_TXN_EXECUTION",
            },
        },
        {
            user: "{{agent}}",
            content: {
                text: "Bridge completed successfully! Transaction ID: ...",
            },
        },
    ],
];
