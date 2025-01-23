import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
    elizaLogger,
    generateText,
    ModelClass,
} from "@elizaos/core";
import { generateSQL, executeQuery } from "../libs/chainbase";
import { responsePrompt } from "../templates";

const QUERY_PREFIX = "query onchain data:";

export const queryBlockChainData: Action = {
    name: "QUERY_BLOCKCHAIN_DATA",
    similes: ["ANALYZE_BLOCKCHAIN", "GET_CHAIN_DATA", "QUERY_ONCHAIN_DATA"],
    description:
        "Query blockchain data using natural language starting with 'query onchain data:'",

    validate: async (runtime: IAgentRuntime, message: Memory) => {
        elizaLogger.log("Validating runtime for QUERY_BLOCKCHAIN_DATA...");
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
        callback?: HandlerCallback
    ) => {
        try {
            const messageText = message.content.text.toLowerCase();

            if (!messageText.includes(QUERY_PREFIX)) {
                callback({
                    text: `Please use the format: ${QUERY_PREFIX} <your natural language query>`,
                });
                return;
            }

            const queryText = message.content.text
                .slice(
                    message.content.text.toLowerCase().indexOf(QUERY_PREFIX) +
                        QUERY_PREFIX.length
                )
                .trim();

            if (!queryText) {
                callback({
                    text: `Please provide a specific query after '${QUERY_PREFIX}'`,
                });
                return;
            }

            // Generate SQL from natural language
            const sql = await generateSQL(queryText);

            // Execute query on Chainbase
            const result = await executeQuery(sql);

            // Use generateText to format the response
            const formattedResponse = await generateText({
                runtime,
                context: responsePrompt(
                    {
                        sql,
                        columns: result.columns,
                        data: result.data,
                        totalRows: result.totalRows,
                    },
                    queryText
                ),
                modelClass: ModelClass.SMALL,
            });

            callback({
                text: formattedResponse,
            });
        } catch (error) {
            elizaLogger.error("Error in queryChainbase action:", error);
            callback({
                text: "An error occurred while querying the blockchain. Please try again later.",
            });
            return ;
        }
    },

    examples: [
        [
            {
                user: "user",
                content: {
                    text: "query onchain data: Calculate the average gas used per block on Ethereum in the last 100 blocks",
                    action: "QUERY_BLOCKCHAIN_DATA",
                },
            },
            {
                user: "assistant",
                content: {
                    text: "📊 Query Results...",
                },
            },
        ],
        [
            {
                user: "user",
                content: {
                    text: "query onchain data: Show me the top 10 active Ethereum addresses by transaction count in the last 1000 blocks",
                    action: "QUERY_BLOCKCHAIN_DATA",
                },
            },
            {
                user: "assistant",
                content: {
                    text: "📊 Query Results...",
                },
            },
        ],
        [
            {
                user: "user",
                content: {
                    text: "query onchain data: List Ethereum transactions with value greater than 1 ETH in the last 1000 blocks",
                    action: "QUERY_BLOCKCHAIN_DATA",
                },
            },
            {
                user: "assistant",
                content: {
                    text: "📊 Query Results...",
                },
            },
        ],
        [
            {
                user: "user",
                content: {
                    text: "query onchain data: Calculate the total ETH transaction fees collected in the last 100 Ethereum blocks",
                    action: "QUERY_BLOCKCHAIN_DATA",
                },
            },
            {
                user: "assistant",
                content: {
                    text: "📊 Query Results...",
                },
            },
        ],
        [
            {
                user: "user",
                content: {
                    text: "query onchain data: Show me the distribution of ETH transaction values in the last 1000 Ethereum transactions",
                    action: "QUERY_BLOCKCHAIN_DATA",
                },
            },
            {
                user: "assistant",
                content: {
                    text: "📊 Query Results...",
                },
            },
        ],
        [
            {
                user: "user",
                content: {
                    text: "query onchain data: Find Ethereum blocks that have more than 200 transactions in the last 24 hours",
                    action: "QUERY_BLOCKCHAIN_DATA",
                },
            },
            {
                user: "assistant",
                content: {
                    text: "📊 Query Results...",
                },
            },
        ],
        [
            {
                user: "user",
                content: {
                    text: "query onchain data: What's the average gas price trend on Ethereum mainnet in the last 1000 blocks",
                    action: "QUERY_BLOCKCHAIN_DATA",
                },
            },
            {
                user: "assistant",
                content: {
                    text: "📊 Query Results...",
                },
            },
        ],
        [
            {
                user: "user",
                content: {
                    text: "query onchain data: Show me Ethereum addresses that have both sent and received ETH in the last 100 blocks",
                    action: "QUERY_BLOCKCHAIN_DATA",
                },
            },
            {
                user: "assistant",
                content: {
                    text: "📊 Query Results...",
                },
            },
        ],
        [
            {
                user: "user",
                content: {
                    text: "query onchain data: List the top 10 Ethereum blocks by total gas used in the last 24 hours",
                    action: "QUERY_BLOCKCHAIN_DATA",
                },
            },
            {
                user: "assistant",
                content: {
                    text: "📊 Query Results...",
                },
            },
        ],
    ],
};
