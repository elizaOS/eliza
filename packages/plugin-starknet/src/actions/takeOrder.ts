import {
    type Action,
    type ActionExample,
    composeContext,
    type Content,
    generateText,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    settings,
} from "@elizaos/core";
import * as fs from "node:fs";  // Added node: protocol
import { validateStarknetConfig } from "../environment";

interface Order {
    userId: string;
    ticker: string;
    contractAddress: string;
    timestamp: string;
    buyAmount: number;
    price: number;
}

const template = `

// CLAUDE TODO: Put the usual conversation context here

Ticker is: {{ticker}}
Contract address is: {{contractAddress}}

Determine if the user is trying to shill the ticker. if they are, respond with empty conviction, ticker and contractAddress.

// CLAUDE TODO: output a JSON block with the following fields:
// - reasoning: string
// - conviction: negative, low, medium, high
// - ticker: string (extract from CA so we have context)
// - contractAddress: string
`;

const take_order: Action = {
    name: "TAKE_STARKNET_ORDER",
    similes: ["BUY_STARKNET_ORDER", "PLACE_STARKNET_ORDER"],
    description:
        "Records a starknet buy order based on the user's conviction level.",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        await validateStarknetConfig(runtime);

        const text = (message.content as Content).text;
        // Check if the message contains a ticker symbol
        const tickerRegex = /\b[A-Z]{1,5}\b/g;
        return tickerRegex.test(text);
    },
    handler: async (runtime: IAgentRuntime, message: Memory) => {
        const _text = (message.content as Content).text;
        const userId = message.userId;

        // Fix: Declare variables separately with explicit types
        let ticker: string | undefined;
        let contractAddress: string | undefined;

        // TODO:

        // 1. create state object with runtime.composeState
        // 2. compose context with template and state
        // 3. get generateText
        // 4. validate generateText

        // if ticker or contractAddress are empty, return a message asking for them
        if (!ticker || !contractAddress) {
            return {
                text: "Ticker and CA?",
            };
        }

        const state = await runtime.composeState(message);
        // TODO: compose context properly
        const context = composeContext({
            state: {
                ...state,
                ticker,
                contractAddress,
            },
            template,
        });

        const convictionResponse = await generateText({
            runtime,
            context: context,
            modelClass: ModelClass.LARGE,
        });

        // TODOL parse and validate the JSON
        const convictionResponseJson = JSON.parse(convictionResponse); // TODO: replace with validate like other actions

        // get the conviction
        const conviction = convictionResponseJson.conviction;

        let buyAmount = 0;
        if (conviction === "low") {
            buyAmount = 20;
        } else if (conviction === "medium") {
            buyAmount = 50;
        } else if (conviction === "high") {
            buyAmount = 100;
        }

        // Get the current price of the asset (replace with actual price fetching logic)
        const currentPrice = 100;

        const order: Order = {
            userId,
            ticker: ticker || "",
            contractAddress,
            timestamp: new Date().toISOString(),
            buyAmount,
            price: currentPrice,
        };

        // Read the existing order book from the JSON file
        const orderBookPath = settings.orderBookPath;
        let orderBook: Order[] = [];
        if (fs.existsSync(orderBookPath)) {
            const orderBookData = fs.readFileSync(orderBookPath, "utf-8");
            orderBook = JSON.parse(orderBookData);
        }

        // Add the new order to the order book
        orderBook.push(order);

        // Write the updated order book back to the JSON file
        fs.writeFileSync(orderBookPath, JSON.stringify(orderBook, null, 2));

        return {
            text: `Recorded a ${conviction} conviction buy order for ${ticker} (${contractAddress}) with an amount of ${buyAmount} at the price of ${currentPrice}.`,
        };
    },
    examples: [] as ActionExample[][],
} as Action;

export default take_order;
