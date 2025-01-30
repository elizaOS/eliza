import {
    type Action,
    type ActionExample,
    type IAgentRuntime,
    type Memory,
    type State,
    type HandlerCallback,
    elizaLogger,
    composeContext,
    ModelClass,
    generateObjectDeprecated,
} from "@elizaos/core";
import { validateSpheronConfig } from "../environment.ts";
import {
    depositBalance,
    getUserBalance,
    withdrawBalance,
} from "../utils/index.ts";
import type { EscrowContent } from "../types/index.ts";
import { SUPPORTED_TOKENS } from "../utils/constants.ts";

// function isEscrowContent(content: any): content is EscrowContent {
//     console.log("Content for escrow operation:", content);
//     return (
//         typeof content.token === "string" &&
//         (content.operation === "deposit" || content.operation === "withdraw"
//             ? typeof content.amount === "number" && content.amount > 0
//             : content.operation === "check") &&
//         (content.operation === "deposit" ||
//             content.operation === "withdraw" ||
//             content.operation === "check")
//     );
// }

function isEscrowContent(content: unknown): content is EscrowContent {
    console.log("Content for escrow operation:", content);

    // First, check if content is an object
    if (typeof content !== 'object' || content === null) {
        return false;
    }

    // Type assertion to access properties safely
    const contentObj = content as Record<string, unknown>;

    return (
        typeof contentObj.token === "string" &&
        (contentObj.operation === "deposit" || contentObj.operation === "withdraw"
            ? typeof contentObj.amount === "number" && contentObj.amount > 0
            : contentObj.operation === "check") &&
        (contentObj.operation === "deposit" ||
            contentObj.operation === "withdraw" ||
            contentObj.operation === "check")
    );
}

const escrowTemplate = `Respond with a JSON markdown block containing only the extracted values
- Use null for any values that cannot be determined.
- Token must be one of the supported tokens.
- Amount must be a positive number.

Example response for checking balance for <token-symbol>:
\`\`\`json
{
    "token": "<token-symbol>", // can be USDT, USDC, DAI, WETH, CST
    "operation": "check"
}
\`\`\`

Example response for depositing <amount> <token-symbol>:
\`\`\`json
{
    "token": "<token-symbol>", // can be USDT, USDC, DAI, WETH, CST
    "amount": <amount>, // must be a positive number
    "operation": "deposit"
}
\`\`\`

Example response for withdrawing <amount> <token-symbol>:
\`\`\`json
{
    "token": "<token-symbol>", // can be USDT, USDC, DAI, WETH, CST
    "amount": <amount>, // must be a positive number
    "operation": "withdraw" // must be one of the supported operations
}
\`\`\`

## Supported Tokens
${Object.entries(SUPPORTED_TOKENS)
    .map(([key, _]) => `- ${key}`)
    .join("\n")}

{{recentMessages}}

Given the recent messages, extract the following information about the requested escrow operation:
- Token symbol (must be one of the supported tokens)
- Amount to deposit/withdraw (must be a positive number)
- Operation type (deposit or withdraw)
- Don't mention multiple operations in the same json block

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: "ESCROW_OPERATION",
    similes: [
        "DEPOSIT_TOKEN",
        "WITHDRAW_TOKEN",
        "CHECK_BALANCE",
        "GET_BALANCE",
        "DEPOSIT_FUNDS",
        "WITHDRAW_FUNDS",
        "ADD_FUNDS",
        "REMOVE_FUNDS",
        "TRANSFER_TO_ESCROW",
        "TRANSFER_FROM_ESCROW",
        "FUND_ACCOUNT",
        "WITHDRAW_FROM_ACCOUNT",
    ],
    description:
        "MUST use this action if the user requests to deposit or withdraw tokens from escrow. The request might vary, but it will always be related to escrow operations.",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await validateSpheronConfig(runtime);
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting ESCROW_OPERATION handler...");

        // Create local variable for state manipulation
        let currentState = state;
        if (!currentState) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(currentState);
        }

        // Filter only "just now" and last couple of user messages
        state.recentMessages = state.recentMessages
            .split("\n")
            .filter(
                (line) => line.includes("(just now)") || line.includes("(user)")
            )
            .slice(-2)
            .join("\n");

        // Compose escrow context
        const escrowContext = composeContext({
            state: currentState,
            template: escrowTemplate,
        });

        // Generate escrow content
        const content = await generateObjectDeprecated({
            runtime,
            context: escrowContext,
            modelClass: ModelClass.SMALL,
        });

        // Validate escrow content
        if (!isEscrowContent(content)) {
            elizaLogger.error("Invalid content for ESCROW_OPERATION action.");
            callback?.({
                text: "Unable to process escrow request. Invalid content provided.",
                content: { error: "Invalid escrow content" },
            });
            return false;
        }

        try {
            const config = await validateSpheronConfig(runtime);
            const balance = await getUserBalance(
                runtime,
                content.token,
                config.WALLET_ADDRESS
            );
            elizaLogger.log(`Current ${content.token} balance:`, balance);

            if (content.operation === "check") {
                const formattedAvailableBalance =
                    Number(balance.unlockedBalance) /
                    10 ** Number(balance.token.decimal);
                const formattedLockedBalance =
                    Number(balance.lockedBalance) /
                    10 ** Number(balance.token.decimal);
                callback?.({
                    text: `Current ${content.token.toUpperCase()} Balance for ${config.WALLET_ADDRESS}\n Available balance: ${formattedAvailableBalance.toFixed(2)} ${content.token.toUpperCase()}\n Locked balance: ${formattedLockedBalance.toFixed(2)} ${content.token.toUpperCase()}`,
                    content: {
                        success: true,
                        unlockedBalance: formattedAvailableBalance,
                        lockedBalance: formattedLockedBalance,
                        token: balance.token,
                        walletAddress: config.WALLET_ADDRESS,
                    },
                });
            } else if (content.operation === "deposit") {
                try {
                    const result = await depositBalance(
                        runtime,
                        content.token,
                        content.amount
                    );
                    callback?.({
                        text: `Successfully deposited ${content.amount} ${content.token.toUpperCase()} into Spheron Escrow for ${config.WALLET_ADDRESS}`,
                        content: {
                            success: true,
                            transaction: result,
                            operation: "deposit",
                            token: content.token,
                            amount: content.amount,
                            newBalance: await getUserBalance(
                                runtime,
                                content.token,
                                config.WALLET_ADDRESS
                            ),
                            walletAddress: config.WALLET_ADDRESS,
                        },
                    });
                } catch (error) {
                    elizaLogger.error("Deposit operation failed:", error);
                    callback?.({
                        text: `Failed to deposit ${content.amount} ${content.token.toUpperCase()}: ${error instanceof Error ? error.message : "Unknown error"}`,
                        content: {
                            success: false,
                            operation: "deposit",
                            token: content.token,
                            amount: content.amount,
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Unknown error",
                        },
                    });
                    return false;
                }
            } else if (content.operation === "withdraw") {
                try {
                    const result = await withdrawBalance(
                        runtime,
                        content.token,
                        content.amount
                    );
                    callback?.({
                        text: `Successfully withdrew ${content.amount} ${content.token.toUpperCase()} from Spheron Escrow for ${config.WALLET_ADDRESS}`,
                        content: {
                            success: true,
                            transaction: result,
                            operation: "withdraw",
                            token: content.token,
                            amount: content.amount,
                            newBalance: await getUserBalance(
                                runtime,
                                content.token,
                                config.WALLET_ADDRESS
                            ),
                            walletAddress: config.WALLET_ADDRESS,
                        },
                    });
                } catch (error) {
                    elizaLogger.error("Withdraw operation failed:", error);
                    callback?.({
                        text: `Failed to withdraw ${content.amount} ${content.token.toUpperCase()}: ${error instanceof Error ? error.message : "Unknown error"}`,
                        content: {
                            success: false,
                            operation: "withdraw",
                            token: content.token,
                            amount: content.amount,
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Unknown error",
                        },
                    });
                    return false;
                }
            } else {
                throw new Error("Invalid operation");
            }

            return true;
        } catch (error) {
            elizaLogger.error("Escrow operation failed:", error);
            callback?.({
                text: "Escrow operation failed",
                content: {
                    error:
                        error instanceof Error
                            ? error.message
                            : "Unknown error",
                },
            });
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Deposit 100 USDT into escrow",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Processing your deposit of 100 USDT...",
                    action: "ESCROW_OPERATION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Withdraw 50 USDC from my balance",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Processing your withdrawal of 50 USDC...",
                    action: "ESCROW_OPERATION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Add 200 DAI to my account",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Processing your deposit of 200 DAI...",
                    action: "ESCROW_OPERATION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Check agent's escrow USDT balance",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Checking your USDT balance...",
                    action: "ESCROW_OPERATION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "How much DAI do I have in agent's escrow?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Let me check your DAI balance...",
                    action: "ESCROW_OPERATION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Transfer 75 USDC to escrow",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Processing your deposit of 75 USDC...",
                    action: "ESCROW_OPERATION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I want to remove 150 DAI from escrow",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Processing your withdrawal of 150 DAI...",
                    action: "ESCROW_OPERATION",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
