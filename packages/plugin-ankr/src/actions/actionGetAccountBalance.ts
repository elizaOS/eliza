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
        elizaLogger.debug(`[GetAccountBalance] ${message}`, data);
        console.log(`[GetAccountBalance] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};
// ------------------------------------------------------------------------------------------------
// Granular Logger
// ------------------------------------------------------------------------------------------------

interface GetAccountBalanceContent extends Content {
    text: string;
    filters?: {
        blockchain?: string[];
        walletAddress?: string;
    };
    success?: boolean;
    data?: {
        address: string;
        balances: Array<{
            blockchain: string;
            tokenName: string;
            symbol: string;
            balance: string;
            balanceRawInteger: string;
            balanceUsd: string;
            tokenDecimals: number;
            tokenType: string;
            contractAddress?: string;
        }>;
    };
}

// Add interface for balance
interface TokenBalance {
    blockchain: string;
    contractAddress?: string;
    tokenName: string;
    tokenSymbol: string;
    tokenDecimals: number;
    tokenType: string;
    holderAddress: string;
    balance: string;
    balanceRawInteger: string;
    balanceUsd: string;
    tokenPrice: string;
}

// ------------------------------------------------------------------------------------------------
// Core Action implementation
// ------------------------------------------------------------------------------------------------
export const actionGetAccountBalance: Action = {
    name: "GET_ACCOUNT_BALANCE_ANKR",
    similes: ["CHECK_BALANCE", "SHOW_BALANCE", "VIEW_BALANCE", "GET_WALLET_BALANCE"],
    description: "Retrieve account balance information across multiple blockchains.",
    examples: [[
        {
            user: "user",
            content: {
                text: "Show me the balance for wallet [wallet]0x1234567890123456789012345678901234567890[/wallet] on [chain]eth[/chain]",
                filters: {
                    blockchain: ["eth"],
                    walletAddress: "0x1234567890123456789012345678901234567890"
                }
            } as GetAccountBalanceContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Here are the balances for wallet 0x1234...7890:\n\n" +
                      "1. ETH (Native)\n" +
                      "   Balance: 1.5 ETH\n" +
                      "   USD Value: $3,000.00\n\n" +
                      "2. USDC (ERC20)\n" +
                      "   Balance: 1000 USDC\n" +
                      "   Contract: 0xa0b8...c4d5\n" +
                      "   USD Value: $1,000.00",
                success: true,
                data: {
                    address: "0x1234567890123456789012345678901234567890",
                    balances: [{
                        blockchain: "eth",
                        tokenName: "Ethereum",
                        symbol: "ETH",
                        balance: "1.5",
                        balanceRawInteger: "1500000000000000000",
                        balanceUsd: "3000.00",
                        tokenDecimals: 18,
                        tokenType: "NATIVE"
                    }, {
                        blockchain: "eth",
                        tokenName: "USD Coin",
                        symbol: "USDC",
                        balance: "1000",
                        balanceRawInteger: "1000000000",
                        balanceUsd: "1000.00",
                        tokenDecimals: 6,
                        tokenType: "ERC20",
                        contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
                    }]
                }
            } as GetAccountBalanceContent
        } as ActionExample
    ]],
    // ------------------------------------------------------------------------------------------------
    // Core Validation implementation
    // ------------------------------------------------------------------------------------------------
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_ACCOUNT_BALANCE_ANKR") {
            return true;
        }

        logGranular("Validating GET_ACCOUNT_BALANCE_ANKR action", {
            content: message.content
        });

        try {
            const content = message.content as GetAccountBalanceContent;

            if (!content.filters?.walletAddress) {
                throw new ValidationError("Wallet address is required");
            }

            if (content.filters?.blockchain && !Array.isArray(content.filters.blockchain)) {
                throw new ValidationError("Blockchain must be an array");
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
        logGranular("Executing GET_ACCOUNT_BALANCE_ANKR action");

        try {
            const messageContent = message.content as GetAccountBalanceContent;
            console.log("Debug - Full message content:", {
                fullContent: message.content,
                rawText: messageContent?.text,
                type: message.content?.type,
                allKeys: Object.keys(message.content || {})
            });

            console.log("Debug - Message content details:", {
                hasText: !!messageContent?.text,
                hasFilters: !!messageContent?.filters,
                textContent: messageContent?.text,
                contentType: typeof messageContent?.text
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
            console.log("Debug - Parsed API content:", {
                hasWallet: !!parsedContent.wallet,
                hasChain: !!parsedContent.chain,
                wallet: parsedContent.wallet,
                chain: parsedContent.chain,
                matches: parsedContent.raw.matches
            });

            // Validate required fields
            validateRequiredFields(parsedContent, ['wallet', 'chain']);

            // Prepare API request parameters
            const requestParams = {
                blockchain: [parsedContent.chain],
                walletAddress: parsedContent.wallet
            };

            console.log("Debug - API request parameters:", {
                params: requestParams,
                endpoint: ANKR_ENDPOINTS.production.multichain
            });

            try {
                const response = await axios.post(
                    endpoint,
                    {
                        jsonrpc: "2.0",
                        method: "ankr_getAccountBalance",
                        params: requestParams,
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

                const balances = response.data.result.assets;
                const address = parsedContent.wallet;

                // Format the response text
                let formattedText = `Here are the balances for wallet ${address?.slice(0, 6)}...${address?.slice(-4)}:\n\n`;

                // Use the interface instead of any
                balances.forEach((balance: TokenBalance, index: number) => {
                    formattedText += `${index + 1}. ${balance.tokenName} (${balance.tokenType})\n`;
                    formattedText += `   Balance: ${balance.balance} ${balance.tokenSymbol}\n`;
                    if (balance.contractAddress) {
                        formattedText += `   Contract: ${balance.contractAddress.slice(0, 6)}...${balance.contractAddress.slice(-4)}\n`;
                    }
                    formattedText += `   USD Value: $${Number.parseFloat(balance.balanceUsd).toFixed(2)}\n\n`;
                });

                // ------------------------------------------------------------------------------------------------
                // Core Callback logic
                // ------------------------------------------------------------------------------------------------
                if (callback) {
                    logGranular("Sending success callback with formatted text", { formattedText });
                    callback({
                        text: formattedText,
                        success: true,
                        data: {
                            address,
                            balances
                        }
                    } as GetAccountBalanceContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to fetch balance data: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch balance data");
            }

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting account balance: ${errorMessage}`,
                    success: false
                } as GetAccountBalanceContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_ACCOUNT_BALANCE_ANKR action");
        }
    }
};

export default actionGetAccountBalance;
