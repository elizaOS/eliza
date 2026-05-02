import type { Plugin } from '@elizaos/core';

// Services
import { NewsDataService } from './services/newsDataService';

// Providers
import { defiNewsProvider } from './providers/defiNewsProvider';

/**
 * DeFi News Plugin
 *
 * A comprehensive plugin that automatically provides DeFi and crypto market context to conversations through providers.
 *
 * Features:
 * - Global DeFi market statistics (market cap, volume, dominance) - requires CoinGecko service
 * - Global crypto market data (active cryptocurrencies, total market cap, dominance) - requires CoinGecko service
 * - Latest crypto news from Brave New Coin RSS feed (always available)
 * - Token information (price, market cap, community stats, developer activity) - requires CoinGecko service
 *
 * Optional Dependencies:
 * - COINGECKO_SERVICE: Provided by analytics plugin or similar for market data
 * - birdeye: For Solana token lookups
 * - chain_solana: For Solana blockchain interactions
 *
 * Required Services:
 * - NEWS_DATA_SERVICE: Provided by this plugin for news data
 *
 * Note: This plugin works standalone with news data only. For full functionality,
 * ensure the analytics plugin (or similar) is loaded to provide the COINGECKO_SERVICE.
 *
 * @author ElizaOS
 * @version 2.0.0
 */
export const defiNewsPlugin: Plugin = {
  name: 'defi-news',
  description:
    'DeFi News plugin that provides comprehensive market context including global DeFi/crypto statistics, token data, and real-world crypto news from CoinGecko and Brave New Coin RSS feed',
  evaluators: [],
  providers: [defiNewsProvider],
  actions: [],
  services: [NewsDataService],
};

export default defiNewsPlugin;

// Export types for external use
export * from './interfaces/types';

// Export services for direct access if needed
export { NewsDataService } from './services/newsDataService';

// Export providers
export { defiNewsProvider } from './providers/defiNewsProvider';

// Export utilities
export * from './utils/formatters';

