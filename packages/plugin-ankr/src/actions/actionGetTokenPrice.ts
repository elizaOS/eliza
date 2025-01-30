// ------------------------------------------------------------------------------------------------
// Essential Imports
// ------------------------------------------------------------------------------------------------
import { Action, elizaLogger } from "@elizaos/core";
import { IAgentRuntime, Memory, State, HandlerCallback, Content, ActionExample } from "@elizaos/core";
// ------------------------------------------------------------------------------------------------
// Essential Imports
// ------------------------------------------------------------------------------------------------
import axios from 'axios';
import { getConfig, validateankrConfig, ANKR_ENDPOINTS } from '../environment';
import { APIError, ConfigurationError, ValidationError } from '../error/base';
import { parseAPIContent, validateRequiredFields } from '../validator/apiParseValidation';
// ------------------------------------------------------------------------------------------------
// Granular Logger
// ------------------------------------------------------------------------------------------------
// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.ANKR_GRANULAR_LOG;

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.debug(`[GetTokenPrice] ${message}`, data);
        console.log(`[GetTokenPrice] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface GetTokenPriceContent extends Content {
    text: string;
    filters?: {
        blockchain?: string;
        contractAddress?: string;
    };
    success?: boolean;
    data?: {
        blockchain: string;
        contractAddress: string;
        usdPrice: string;
        syncStatus: {
            timestamp: number;
            lag: string;
            status: string;
        };
    };
}

export const actionGetTokenPrice: Action = {
    name: "GET_TOKEN_PRICE_ANKR",
    similes: ["CHECK_PRICE", "TOKEN_PRICE", "CRYPTO_PRICE", "PRICE_CHECK"],
    description: "Get the current USD price for any token on eth blockchain.",



    examples: [[
        {
            user: "user",
            content: {
                text: "What's the current price of [contract]0x8290333cef9e6d528dd5618fb97a76f268f3edd4[/contract] token [chain]eth[/chain]",
                filters: {
                    blockchain: "eth",
                    contractAddress: "0x8290333cef9e6d528dd5618fb97a76f268f3edd4"
                }
            } as GetTokenPriceContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Current token price on eth:\n\n" +
                      "Price: $0.03024 USD\n" +
                      "Contract: 0x8290...3edd4\n" +
                      "Sync Status: synced (lag: -8s)",
                success: true,
                data: {
                    blockchain: "eth",
                    contractAddress: "0x8290333cef9e6d528dd5618fb97a76f268f3edd4",
                    usdPrice: "0.030239944206509556547",
                    syncStatus: {
                        timestamp: 1737760907,
                        lag: "-8s",
                        status: "synced"
                    }
                }
            } as GetTokenPriceContent
        } as ActionExample
    ]],
    // ------------------------------------------------------------------------------------------------
    // Core Validation implementation
    // ------------------------------------------------------------------------------------------------
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_TOKEN_PRICE_ANKR") {
            return true;
        }

        logGranular("Validating GET_TOKEN_PRICE_ANKR action", {
            content: message.content
        });

        try {
            const content = message.content as GetTokenPriceContent;
            const parsedContent = parseAPIContent(content.text);

            if (!parsedContent.chain || !parsedContent.contract) {
                throw new ValidationError("Blockchain and contract address are required");
            }

            logGranular("Validation successful");
            return true;
        } catch (error) {
            logGranular("Validation failed", { error });
            if (error instanceof ValidationError) {
                throw error;
            }
            throw new ValidationError(error instanceof Error ? error.message : "Unknown validation error");
        }
    },
    // ------------------------------------------------------------------------------------------------
    // Core Handler implementation
    // ------------------------------------------------------------------------------------------------
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State,
        _options: { [key: string]: unknown } = {},
        callback?: HandlerCallback
    ): Promise<boolean> => {
        logGranular("Executing GET_TOKEN_PRICE_ANKR action");

        try {
            const messageContent = message.content as GetTokenPriceContent;
            console.log("Debug - Full message content:", {
                fullContent: message.content,
                rawText: messageContent?.text,
                type: message.content?.type,
                allKeys: Object.keys(message.content || {})
            });
            const config = await validateankrConfig(runtime);
            console.log("Debug - Config validated:", {
                hasWallet: !!config.ANKR_WALLET,
                env: config.ANKR_ENV
            });

            const wallet = config.ANKR_WALLET;
            if (!wallet) {
                throw new ConfigurationError("ANKR_WALLET not found in environment variables");
            }

            const endpoint = `https://rpc.ankr.com/multichain/${wallet}`;

            // Parse the prompt using our API content parser
            console.log("Debug - Raw prompt:", {
                text: messageContent.text,
                promptLength: messageContent.text?.length,
            });
            const parsedContent = parseAPIContent(messageContent.text);
            validateRequiredFields(parsedContent, ['contract', 'chain']);

            try {
                const response = await axios.post(
                    endpoint,
                    {
                        jsonrpc: "2.0",
                        method: "ankr_getTokenPrice",
                        params: {
                            blockchain: parsedContent.chain,
                            contractAddress: parsedContent.contract
                        },
                        id: 1
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    }
                );

                logGranular("Received response from Ankr API", {
                    statusCode: response.status,
                    data: response.data
                });

                if (response.data.error) {
                    throw new APIError(`Ankr API error: ${response.data.error.message}`);
                }

                const result = response.data.result;
                const price = Number(result.usdPrice).toFixed(5);

                const formattedText = `Current token price on ${parsedContent.chain}:\n\n` +
                    `Price: $${price} USD\n` +
                    `Contract: ${result.contractAddress.slice(0, 6)}...${result.contractAddress.slice(-4)}\n` +
                    `Sync Status: ${result.syncStatus.status} (lag: ${result.syncStatus.lag})`;

                if (callback) {
                    callback({
                        text: formattedText,
                        success: true,
                        data: result
                    } as GetTokenPriceContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to fetch token price: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch token price");
            }

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting token price: ${errorMessage}`,
                    success: false
                } as GetTokenPriceContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_TOKEN_PRICE_ANKR action");
        }
    }
};

export default actionGetTokenPrice;
