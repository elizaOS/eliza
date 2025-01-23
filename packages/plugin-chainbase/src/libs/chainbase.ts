import { elizaLogger } from "@elizaos/core";
import { CHAINBASE_API_URL_ENDPOINT } from "../constants";

export interface TokenWithBalance {
    name: string;
    symbol: string;
    balance: string;
    decimals: number;
    contract_address: string;
}

export interface TokenBalanceParams {
    chain_id: number;
    address: string;
    contract_address?: string;
}

export async function generateSQL(prompt: string): Promise<string> {
    try {
        const response = await fetch(
            `${CHAINBASE_API_URL_ENDPOINT}/api/v1/text2sql`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    assistant_id: "6b86c502-d203-4f6b-baf6-f406c23a9421",
                    input: {
                        messages: [
                            {
                                type: "human",
                                content: prompt,
                            },
                        ],
                    },
                }),
            }
        );

        const data = await response.json();
        elizaLogger.log("Generated SQL:", data.sql);
        return data.sql;
    } catch (error) {
        elizaLogger.error("Error generating SQL:", error);
        throw error;
    }
}

const POLL_INTERVAL = 1000; // 1 second
const MAX_RETRIES = 180; // Maximum number of retries (3 minute)

// Add new utility function
function getChainbaseApiKey(): string {
    const apiKey = process.env.CHAINBASE_API_KEY;
    if (!apiKey) {
        throw new Error(
            "CHAINBASE_API_KEY is not set in environment variables"
        );
    }
    return apiKey;
}

export async function executeQuery(sql: string): Promise<any> {
    try {
        const apiKey = getChainbaseApiKey();

        // Process SQL line breaks and semicolons
        const processedSql = sql
            .replace(/\n/g, " ") // Replace line breaks with spaces
            .replace(/;/g, "") // Remove semicolons
            .trim();

        // 1. Execute query
        elizaLogger.log("Executing Chainbase query:", processedSql);
        const executeResponse = await fetch(
            `${CHAINBASE_API_URL_ENDPOINT}/api/v1/query/execute`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-API-KEY": apiKey,
                },
                body: JSON.stringify({ sql: processedSql }),
            }
        );

        const executeData = await executeResponse.json();
        elizaLogger.log("Execute response:", executeData);
        const executionId = executeData.data[0].executionId;

        if (!executionId) {
            throw new Error("Failed to get execution_id from query execution");
        }

        // 2. Poll for results
        let retries = 0;
        while (retries < MAX_RETRIES) {
            elizaLogger.log(
                `Polling results (attempt ${retries + 1}/${MAX_RETRIES})...`
            );
            const resultResponse = await fetch(
                `${CHAINBASE_API_URL_ENDPOINT}/api/v1/execution/${executionId}/results`,
                {
                    method: "GET",
                    headers: {
                        "Content-Type": "application/json",
                        "X-API-KEY": apiKey,
                    },
                }
            );

            const response = await resultResponse.json();
            elizaLogger.log("Poll response:", response);

            // If query fails, return error immediately
            if (response.data.status === "FAILED") {
                throw new Error(
                    response.data.message || "Query failed with unknown error"
                );
            }

            // If query completes, return results
            if (response.data.status === "FINISHED") {
                elizaLogger.log("Query succeeded:", response.data);
                return {
                    columns: response.data.columns,
                    data: response.data.data,
                    totalRows: response.data.total_row_count,
                };
            }

            // Wait specified interval before polling again
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
            retries++;
        }

        throw new Error("Query timeout after 180 seconds");
    } catch (error) {
        elizaLogger.error("Error executing Chainbase query:", error);
        throw error;
    }
}

export async function getTokenBalances(
    params: TokenBalanceParams
): Promise<TokenWithBalance[]> {
    try {
        const apiKey = getChainbaseApiKey();

        elizaLogger.log("Fetching token balances:", params);

        const response = await fetch(
            `${CHAINBASE_API_URL_ENDPOINT}/v1/account/tokens?chain_id=${params.chain_id}&address=${params.address}&limit=100`,
            {
                method: "GET",
                headers: {
                    "x-api-key": apiKey,
                },
            }
        );

        const { data } = (await response.json()) as {
            data?: TokenWithBalance[];
        };

        if (!data) {
            throw new Error("No data returned from Chainbase API");
        }

        elizaLogger.log("Token balances retrieved:", data);

        // Filter out tokens without name and symbol
        return data.filter(
            (token) => !(token.name.length === 0 && token.symbol.length === 0)
        );
    } catch (error) {
        elizaLogger.error("Error fetching token balances:", error);
        throw error;
    }
}

export function formatTokenBalance(token: TokenWithBalance): string {
    // Handle balance in hex format
    const balanceValue = token.balance.startsWith("0x")
        ? parseInt(token.balance, 16)
        : parseFloat(token.balance);

    const balance = balanceValue / Math.pow(10, token.decimals);
    return `${balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${token.symbol} (${token.name})`;
}
