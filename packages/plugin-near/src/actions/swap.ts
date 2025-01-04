import {
    ActionExample,
    HandlerCallback,
    elizaLogger,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    type Action,
    composeContext,
    generateObject,
} from "@elizaos/core";
import { connect, keyStores, utils } from "near-api-js";
import {
    init_env,
    ftGetTokenMetadata,
    estimateSwap,
    instantSwap,
    fetchAllPools,
    FT_MINIMUM_STORAGE_BALANCE_LARGE,
    ONE_YOCTO_NEAR,
} from "@ref-finance/ref-sdk";
import { walletProvider } from "../providers/wallet";
import { KeyPairString } from "near-api-js/lib/utils";

async function checkStorageBalance(
    account: any,
    contractId: string
): Promise<boolean> {
    try {
        const balance = await account.viewFunction({
            contractId,
            methodName: "storage_balance_of",
            args: { account_id: account.accountId },
        });
        return balance !== null && balance.total !== "0";
    } catch (error) {
        elizaLogger.log(`Error checking storage balance: ${error}`);
        return false;
    }
}

async function swapToken(
    runtime: IAgentRuntime,
    inputTokenId: string,
    outputTokenId: string,
    amount: string,
    slippageTolerance: number = Number(
        runtime.getSetting("SLIPPAGE_TOLERANCE")
    ) || 0.01
): Promise<any> {
    try {
        // Get token metadata
        const tokenIn = await ftGetTokenMetadata(inputTokenId);
        const tokenOut = await ftGetTokenMetadata(outputTokenId);
        const networkId = runtime.getSetting("NEAR_NETWORK") || "testnet";
        const nodeUrl =
            runtime.getSetting("RPC_URL") || "https://rpc.testnet.near.org";

        // Get all pools for estimation
        // ratedPools, unRatedPools,
        const { simplePools } = await fetchAllPools();
        const swapTodos = await estimateSwap({
            tokenIn,
            tokenOut,
            amountIn: amount,
            simplePools,
            options: {
                enableSmartRouting: true,
            },
        });

        if (!swapTodos || swapTodos.length === 0) {
            throw new Error("No valid swap route found");
        }

        // Get account ID from runtime settings
        const accountId = runtime.getSetting("NEAR_ADDRESS");
        if (!accountId) {
            throw new Error("NEAR_ADDRESS not configured");
        }

        const secretKey = runtime.getSetting("NEAR_WALLET_SECRET_KEY");
        const keyStore = new keyStores.InMemoryKeyStore();
        const keyPair = utils.KeyPair.fromString(secretKey as KeyPairString);
        await keyStore.setKey(networkId, accountId, keyPair);

        const nearConnection = await connect({
            networkId,
            keyStore,
            nodeUrl,
        });

        const account = await nearConnection.account(accountId);

        // Check storage balance for both tokens
        const hasStorageIn = await checkStorageBalance(account, inputTokenId);
        const hasStorageOut = await checkStorageBalance(account, outputTokenId);

        const transactions = await instantSwap({
            tokenIn,
            tokenOut,
            amountIn: amount,
            swapTodos,
            slippageTolerance,
            AccountId: accountId,
        });

        // If storage deposit is needed, add it to transactions
        if (!hasStorageIn) {
            transactions.unshift({
                receiverId: inputTokenId,
                functionCalls: [
                    {
                        methodName: "storage_deposit",
                        args: {
                            account_id: accountId,
                            registration_only: true,
                        },
                        gas: "30000000000000",
                        amount: FT_MINIMUM_STORAGE_BALANCE_LARGE,
                    },
                ],
            });
        }

        if (!hasStorageOut) {
            transactions.unshift({
                receiverId: outputTokenId,
                functionCalls: [
                    {
                        methodName: "storage_deposit",
                        args: {
                            account_id: accountId,
                            registration_only: true,
                        },
                        gas: "30000000000000",
                        amount: FT_MINIMUM_STORAGE_BALANCE_LARGE,
                    },
                ],
            });
        }

        return transactions;
    } catch (error) {
        elizaLogger.error("Error in swapToken:", error);
        throw error;
    }
}

const swapTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "inputTokenId": "wrap.testnet",
    "outputTokenId": "ref.fakes.testnet",
    "amount": "1.5"
}
\`\`\`

{{recentMessages}}

Given the recent messages and wallet information below:

{{walletInfo}}

Extract the following information about the requested token swap:
- Input token ID (the token being sold)
- Output token ID (the token being bought)
- Amount to swap

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined. The result should be a valid JSON object with the following schema:
\`\`\`json
{
    "inputTokenId": string | null,
    "outputTokenId": string | null,
    "amount": string | null
}
\`\`\``;

export const executeSwap: Action = {
    name: "EXECUTE_SWAP_NEAR",
    similes: [
        "SWAP_TOKENS_NEAR",
        "TOKEN_SWAP_NEAR",
        "TRADE_TOKENS_NEAR",
        "EXCHANGE_TOKENS_NEAR",
    ],
    validate: async (_runtime: IAgentRuntime, message: Memory) => {
        elizaLogger.log("Message:", message);
        return true;
    },
    description: "Perform a token swap using Ref Finance.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        // Initialize Ref SDK with testnet environment
        init_env(runtime.getSetting("NEAR_NETWORK") || "testnet");
        // Compose state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        const walletInfo = await walletProvider.get(runtime, message, state);
        state.walletInfo = walletInfo;

        const swapContext = composeContext({
            state,
            template: swapTemplate,
        });

        const response = await generateObject({
            runtime,
            context: swapContext,
            modelClass: ModelClass.LARGE,
        });

        elizaLogger.log("Response:", response);

        if (
            !response.inputTokenId ||
            !response.outputTokenId ||
            !response.amount
        ) {
            elizaLogger.log("Missing required parameters, skipping swap");
            const responseMsg = {
                text: "I need the input token ID, output token ID, and amount to perform the swap",
            };
            callback?.(responseMsg);
            return true;
        }

        try {
            // Get account credentials
            const accountId = runtime.getSetting("NEAR_ADDRESS");
            const secretKey = runtime.getSetting("NEAR_WALLET_SECRET_KEY");

            if (!accountId || !secretKey) {
                throw new Error("NEAR wallet credentials not configured");
            }

            // Create keystore and connect to NEAR
            const keyStore = new keyStores.InMemoryKeyStore();
            const keyPair = utils.KeyPair.fromString(
                secretKey as KeyPairString
            );
            await keyStore.setKey("testnet", accountId, keyPair);

            const nearConnection = await connect({
                networkId: runtime.getSetting("NEAR_NETWORK") || "testnet",
                keyStore,
                nodeUrl:
                    runtime.getSetting("RPC_URL") ||
                    "https://rpc.testnet.near.org",
            });

            // Execute swap
            const swapResult = await swapToken(
                runtime,
                response.inputTokenId,
                response.outputTokenId,
                response.amount,
                Number(runtime.getSetting("SLIPPAGE_TOLERANCE")) || 0.01
            );

            // Sign and send transactions
            const account = await nearConnection.account(accountId);
            const results = [];

            for (const tx of swapResult) {
                for (const functionCall of tx.functionCalls) {
                    const result = await account.functionCall({
                        contractId: tx.receiverId,
                        methodName: functionCall.methodName,
                        args: functionCall.args,
                        gas: functionCall.gas,
                        attachedDeposit: BigInt(
                            functionCall.amount === ONE_YOCTO_NEAR
                                ? "1"
                                : functionCall.amount
                        ),
                    });
                    results.push(result);
                }
            }

            elizaLogger.log("Swap completed successfully!");
            const txHashes = results.map((r) => r.transaction.hash).join(", ");

            const responseMsg = {
                text: `Swap completed successfully! Transaction hashes: ${txHashes}`,
            };

            callback?.(responseMsg);
            return true;
        } catch (error) {
            elizaLogger.error("Error during token swap:", error);
            const responseMsg = {
                text: `Error during swap: ${error instanceof Error ? error.message : String(error)}`,
            };
            callback?.(responseMsg);
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    inputTokenId: "wrap.testnet",
                    outputTokenId: "ref.fakes.testnet",
                    amount: "1.0",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Swapping 1.0 NEAR for REF...",
                    action: "TOKEN_SWAP",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Swap completed successfully! Transaction hash: ...",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
