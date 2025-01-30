import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
    elizaLogger,
    ModelClass,
    composeContext,
    generateObject,
    generateText,
} from "@elizaos/core";
import Big from "big.js";
import { getTokenBalances } from "../libs/chainbase";
import {
    retrieveTokenBalanceTemplate,
    formatTokenBalancePrompt,
} from "../templates";
import {
    RetrieveTokenBalanceReqSchema,
    isRetrieveTokenBalanceReq,
} from "../types";

export const retrieveTokenBalance: Action = {
    name: "RETRIEVE_TOKEN_BALANCE",
    similes: [
        "RETRIEVE_ALL_TOKENS",
        "FETCH_ERC20_TOKENS",
        "RETRIEVE_ERC20_TOKENS_BALANCE",
        "RETRIEVE_TOKEN_BALANCE_LIST",
    ],
    description:
        "Retrieve all token balances for all ERC20 tokens for a specified address.",

    validate: async (runtime: IAgentRuntime, message: Memory) => {
        elizaLogger.log("Validating runtime for RETRIEVE_TOKEN_BALANCE...");
        return !!(
            runtime.character.settings.secrets?.CHAINBASE_API_KEY ||
            process.env.CHAINBASE_API_KEY
        );
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: { [key: string]: unknown },
        callback?: HandlerCallback,
    ) => {
        try {
            elizaLogger.log("Composing state for message:", message);
            if (!state) {
                state = (await runtime.composeState(message)) as State;
            } else {
                state = await runtime.updateRecentMessageState(state);
            }

            const context = composeContext({
                state,
                template: retrieveTokenBalanceTemplate,
            });

            const queryParams = await generateObject({
                runtime,
                context,
                modelClass: ModelClass.LARGE,
                schema: RetrieveTokenBalanceReqSchema,
            });

            if (!isRetrieveTokenBalanceReq(queryParams.object)) {
                callback(
                    {
                        text: "Invalid query params. Please check the inputs.",
                    },
                    [],
                );
                return;
            }

            const { contract_address, address, chain_id } = queryParams.object;

            elizaLogger.log("Querying token balances:", {
                chain_id,
                address,
                contract_address,
            });
            const tokens = await getTokenBalances({
                chain_id: Number(chain_id),
                address,
                contract_address,
            });

            // Convert hex balance to decimal and adjust for token decimals
            const processedTokens = tokens.map((token) => ({
                ...token,
                balance: token.balance
                    ? new Big(parseInt(token.balance, 16).toString())
                          .div(new Big(10).pow(token.decimals))
                          .toFixed(18)
                    : "0",
            }));

            if (processedTokens.length > 0) {
                const formattedResponse = await generateText({
                    runtime,
                    context: formatTokenBalancePrompt(processedTokens, address),
                    modelClass: ModelClass.SMALL,
                });

                callback({
                    text: formattedResponse,
                });
            } else {
                callback({
                    text: `💫 No token balances found for address ${address}`,
                });
            }
        } catch (error) {
            elizaLogger.error("Error in retrieveTokenBalance:", error.message);
            callback({
                text: "❌ An error occurred while retrieving token balances. Please try again later.",
            });
        }
    },

    examples: [
        [
            {
                user: "user",
                content: {
                    text: "Retrieve Ethereum token balances of address 0x7719fD6A5a951746c8c26E3DFd143f6b96Db6412",
                    action: "RETRIEVE_TOKEN_BALANCE",
                },
            },
            {
                user: "assistant",
                content: {
                    text: "Sure! there're 20.25 USDT in address 0x7719fD6A5a951746c8c26E3DFd143f6b96Db6412",
                },
            },
        ],
    ],
};
