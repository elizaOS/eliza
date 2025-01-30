import {
    type ActionExample,
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    composeContext,
    elizaLogger,
    generateObject,
    type Action,
} from "@elizaos/core";
import { z } from "zod";
import { walletProvider } from "../providers/wallet";
import { PublicKey, TokenId, fetchAccount } from "o1js";
import type { UInt64 } from "o1js";
import BigNumber from "bignumber.js";

export interface BalanceContent extends Content {
    address: string;
    token: string | null;
}

function isBalanceContent(content: Content): content is BalanceContent {
    console.log("Content for Balance", content);
    return typeof content.address === "string";
}

const BalanceTemplate = `Given the recent messages and wallet information below:

Example response:
\`\`\`json
{
    "address": "B62qkGSBuLmqYApYoWTmAzUtwFVx6Fe9ZStJVPzCwLjWZ5NQDYTiqEU",
}
\`\`\`

{{recentMessages}}

{{walletInfo}}

Extract the following information about the requested Balance request:
- Address to check balance for.

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.`;

interface MinaAccount {
    account: {
        balance: UInt64;
    };
}

export default {
    name: "BALANCE",
    similes: ["BALANCE", "GET_BALANCE", "CHECK_BALANCE"],
    validate: async (_runtime: IAgentRuntime, message: Memory) => {
        console.log("Validating mina Balance from user:", message.userId);
        return true;
    },
    description: "Get test tokens from the Balance",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback,
    ): Promise<boolean> => {
        elizaLogger.log("Starting Balance handler...");

        const walletInfo = await walletProvider.get(runtime, message, state);
        state.walletInfo = walletInfo;

        // Initialize or update state
        let currentState: State;
        if (!state) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(state);
        }
        
        // Define the schema for the expected output
        const BalanceSchema = z.object({
            address: z.string(),
            token: z.union([z.string(), z.null()]),
        });
        
        // Compose Balance context
        const BalanceContext = composeContext({
            state: currentState,
            template: BalanceTemplate,
        });

        // Generate Balance content with the schema
        const content = await generateObject({
            runtime,
            context: BalanceContext,
            schema: BalanceSchema,
            modelClass: ModelClass.SMALL,
        });

        const BalanceContent = content.object as BalanceContent;

        // Validate Balance content
        if (!isBalanceContent(BalanceContent)) {
            console.error("Invalid content for Balance action.");
            if (callback) {
                callback({
                    text: "Unable to process Balance request. Invalid content provided.",
                    content: { error: "Invalid Balance content" },
                });
            }
            return false;
        }

        try {
            const address = PublicKey.fromBase58(BalanceContent.address);
            let account: MinaAccount;
            if (!BalanceContent.token) {
                account = await fetchAccount({ publicKey: address });
            } else {
                const tokenId = TokenId.fromBase58(BalanceContent.token);
                account = await fetchAccount({
                    publicKey: address,
                    tokenId,
                });
            }
            const balance = new BigNumber(
                account.account.balance.toString()
            ).div(1e9).toFixed(2);

            console.log("Balance successful: ", balance.toString());

            if (callback) {
                if (!BalanceContent.token) {
                    BalanceContent.token = "MINA";
                }

                callback({
                    text: `Balance of ${BalanceContent.address} token: ${BalanceContent.token} is ${balance.toString()}`,
                    content: {
                        success: true,
                        address: BalanceContent.address,
                        balance: balance,
                    },
                });
            }

            return true;
        } catch (error) {
            console.error("Error during token Balance:", error);
            if (callback) {
                callback({
                    text: `Error Balance tokens: ${error.message}`,
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
                    text: "Check my balance of MINA",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you check your balance of MINA",
                    action: "GET_BALANCE",
                    content: {
                        address: "{{walletAddress}}",
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Check my balance of token wS4yycHzda47pSpYCKdSWsHtSHRTTMWGPb97uc6dUVw3Rpqo3o",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you check your balance of token wS4yycHzda47pSpYCKdSWsHtSHRTTMWGPb97uc6dUVw3Rpqo3o",
                    action: "GET_BALANCE",
                    content: {
                        address: "{{walletAddress}}",
                        token: "wS4yycHzda47pSpYCKdSWsHtSHRTTMWGPb97uc6dUVw3Rpqo3o",
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Get MINA balance of B62qkGSBuLmqYApYoWTmAzUtwFVx6Fe9ZStJVPzCwLjWZ5NQDYTiqEU",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you check MINA balance of B62qkGSBuLmqYApYoWTmAzUtwFVx6Fe9ZStJVPzCwLjWZ5NQDYTiqEU",
                    action: "GET_BALANCE",
                    content: {
                        address:
                            "B62qkGSBuLmqYApYoWTmAzUtwFVx6Fe9ZStJVPzCwLjWZ5NQDYTiqEU",
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Check my wallet balance on MINA",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you check your wallet balance on MINA",
                    action: "GET_BALANCE",
                    content: {
                        address: "{{walletAddress}}",
                    },
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
