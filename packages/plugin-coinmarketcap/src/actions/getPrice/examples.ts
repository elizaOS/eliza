import { ActionExample } from "@elizaos/core";

export const priceExamples: ActionExample[][] = [
    [
        {
            user: "{{user1}}",
            content: {
                text: "What's the current price of Bitcoin?",
            },
        },
        {
            user: "{{agent}}",
            content: {
                text: "Let me check the current Bitcoin price for you.",
                action: "GET_PRICE",
            },
        },
        {
            user: "{{agent}}",
            content: {
                text: "The current price of BTC is 65,432.21 USD",
            },
        },
    ],
    [
        {
            user: "{{user1}}",
            content: {
                text: "Check ETH price in EUR",
            },
        },
        {
            user: "{{agent}}",
            content: {
                text: "I'll check the current Ethereum price in EUR.",
                action: "GET_PRICE",
            },
        },
        {
            user: "{{agent}}",
            content: {
                text: "The current price of ETH is 2,345.67 EUR",
            },
        },
    ],
];
