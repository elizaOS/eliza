import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { extractChain } from "../utils";
import type { WalletPortfolioResponse } from "../types/api/wallet";
import { BIRDEYE_SERVICE_NAME } from '../constants';

/**
 * Agent portfolio data provider that queries Birdeye API for the agent's wallet address.
 * When a wallet address is set, this provider fetches portfolio data to give the agent
 * context about the agent's holdings when responding to queries.
 *
 * The provider:
 * - Validates the agent's wallet address
 * - Fetches current portfolio data from Birdeye including token balances and metadata
 * - Makes this portfolio context available to the agent for responding to user queries
 * about their holdings, token values, etc.
 */
export const agentPortfolioProvider: Provider = {
    name: 'BIRDEYE_WALLET_PORTFOLIO',
    description: 'Birdeye intel on agent\'s walllet',
    dynamic: true,
    get: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state?: State
    ) => {
        try {
            const walletAddr = runtime.getSetting("BIRDEYE_WALLET_ADDR");

            // Guard against undefined wallet address
            if (!walletAddr) {
                runtime.logger?.error("BIRDEYE_WALLET_ADDR setting is not configured");
                return {
                    values: {},
                    text: 'Wallet address is not configured. Please set BIRDEYE_WALLET_ADDR.',
                    data: {}
                };
            }

            // Get explicit chain setting if provided
            const explicitChain = runtime.getSetting("BIRDEYE_CHAIN");
            const chain = extractChain(walletAddr, explicitChain);

            // Guard against Birdeye service being unavailable
            const beService = runtime.getService(BIRDEYE_SERVICE_NAME) as any;
            if (!beService || typeof beService.fetchWalletTokenList !== 'function') {
                runtime.logger?.error("Birdeye service is unavailable or does not have fetchWalletTokenList method");
                return {
                    values: {},
                    text: 'Birdeye portfolio service is currently unavailable. Please try again later.',
                    data: {}
                };
            }

            const resp = await beService.fetchWalletTokenList(chain, walletAddr, {
                notOlderThan: 30 * 1000
            })

            // wallet, totalUsd, items
            /*
            address: "So11111111111111111111111111111111111111111",
            decimals: 9,
            balance: 102293438,
            uiAmount: 0.102293438,
            chainId: "solana",
            name: "SOL",
            symbol: "SOL",
            logoURI: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
            priceUsd: 201.53825158945534,
            valueUsd: 20.616040643594353,
            isScaledUiToken: false,
            multiplier: null,
            */
            //console.log('resp', resp)

            const wrapper = { success: true, data: resp }

            const portfolioText = formatPortfolio(wrapper);

            //console.log('walletAddr', walletAddr, 'portfolioText', portfolioText)

            const text = `This is your wallet address: ${walletAddr}\n\nThis is your portfolio: [${portfolioText}]`;

            return {
                data: resp,
                values: {},
                text,
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            runtime.logger?.error(`Error fetching token data: ${errorMessage}`);

            // If it's a configuration/validation error (from extractChain), show it to the user
            const isConfigError = errorMessage.includes('BIRDEYE_CHAIN') ||
                errorMessage.includes('address') ||
                errorMessage.includes('Invalid');

            return {
                values: {},
                text: isConfigError
                    ? errorMessage
                    : 'Unable to fetch wallet portfolio data at this time. Please try again later.',
                data: {}
            };
        }
    },
};

export const formatPortfolio = (response: WalletPortfolioResponse) => {
    const { items } = response.data;
    if (!items?.length) return "No tokens found in portfolio";

    return items
        .map((item) => {
            const value = item?.priceUsd?.toFixed(2);
            const amount = Number(item?.uiAmount?.toFixed(4));
            return (
                `• ${item.symbol || "Unknown Token"}: ${isNaN(amount) ? "?" : amount.toLocaleString()} tokens` +
                `${value !== "0.00" ? ` (Value: $${value || "unknown"})` : ""}`
            );
        })
        .join("\n");
};
