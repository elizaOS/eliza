import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import BigNumber from 'bignumber.js';
import { SOLANA_WALLET_DATA_CACHE_KEY } from '../constants';
import type { WalletPortfolio } from '../types';

// Define the ProviderResult interface if not already imported
/**
 * Represents the result returned by a provider.
 * @typedef {Object} ProviderResult
 * @property {any} [data] - The data associated with the result.
 * @property {Record<string, string>} [values] - The values stored in key-value pairs.
 * @property {string} [text] - The text content of the result.
 */
interface ProviderResult {
  data?: any;
  values?: Record<string, string>;
  text?: string;
}

/**
 * Wallet provider for Solana.
 * @param {IAgentRuntime} runtime - The agent runtime.
 * @param {Memory} _message - The memory message.
 * @param {State} [state] - Optional state parameter.
 * @returns {Promise<ProviderResult>} The result of the wallet provider.
 */
export const walletProvider: Provider = {
  name: 'solana-wallet',
  get: async (runtime: IAgentRuntime, _message: Memory, state?: State): Promise<ProviderResult> => {
    try {
      const portfolioCache = await runtime.getCache<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY);
      if (!portfolioCache) {
        return { data: null, values: {}, text: '' };
      }

      const portfolio = portfolioCache;
      const agentName = state?.agentName || 'The agent';

      // Values that can be injected into templates
      const values: Record<string, string> = {
        total_usd: new BigNumber(portfolio.totalUsd).toFixed(2),
        total_sol: portfolio.totalSol.toString(),
      };

      // Add token balances to values
      portfolio.items.forEach((item, index) => {
        if (new BigNumber(item.uiAmount).isGreaterThan(0)) {
          values[`token_${index}_name`] = item.name;
          values[`token_${index}_symbol`] = item.symbol;
          values[`token_${index}_amount`] = new BigNumber(item.uiAmount).toFixed(6);
          values[`token_${index}_usd`] = new BigNumber(item.valueUsd).toFixed(2);
          values[`token_${index}_sol`] = item.valueSol.toString();
        }
      });

      // Add market prices to values
      if (portfolio.prices) {
        values.sol_price = new BigNumber(portfolio.prices.solana.usd).toFixed(2);
        values.btc_price = new BigNumber(portfolio.prices.bitcoin.usd).toFixed(2);
        values.eth_price = new BigNumber(portfolio.prices.ethereum.usd).toFixed(2);
      }

      // Format the text output
      let text = `${agentName}'s Solana Wallet\n`;
      text += `Total Value: $${values.total_usd} (${values.total_sol} SOL)\n\n`;

      // Token Balances
      text += 'Token Balances:\n';
      const nonZeroItems = portfolio.items.filter((item) =>
        new BigNumber(item.uiAmount).isGreaterThan(0)
      );

      if (nonZeroItems.length === 0) {
        text += 'No tokens found with non-zero balance\n';
      } else {
        for (const item of nonZeroItems) {
          const valueUsd = new BigNumber(item.valueUsd).toFixed(2);
          text += `${item.name} (${item.symbol}): ${new BigNumber(item.uiAmount).toFixed(
            6
          )} ($${valueUsd} | ${item.valueSol} SOL)\n`;
        }
      }

      // Market Prices
      if (portfolio.prices) {
        text += '\nMarket Prices:\n';
        text += `SOL: $${values.sol_price}\n`;
        text += `BTC: $${values.btc_price}\n`;
        text += `ETH: $${values.eth_price}\n`;
      }

      return {
        data: portfolio,
        values: values,
        text: text,
      };
    } catch (error) {
      console.error('Error in Solana wallet provider:', error);
      return { data: null, values: {}, text: '' };
    }
  },
};
