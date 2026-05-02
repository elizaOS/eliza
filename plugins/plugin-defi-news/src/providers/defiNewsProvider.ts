import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import { NewsDataService } from '../services/newsDataService';

/**
 * DeFi News Provider
 *
 * Automatically provides comprehensive DeFi and crypto market context to conversations.
 * This provider is dynamic and fetches fresh data on each request.
 *
 * The provider aggregates data from:
 * - Global DeFi market statistics (market cap, volume, dominance) - requires CoinGecko service
 * - Global crypto market data (total market cap, active cryptocurrencies, dominance) - requires CoinGecko service
 * - Latest crypto news from Brave New Coin RSS feed (top 5 articles) - always available
 * - Token-specific data when mentioned - requires CoinGecko and optional Birdeye services
 *
 * The data is formatted as a comprehensive market report that can be used
 * by the agent to provide informed responses about DeFi and crypto markets.
 *
 * Note: The CoinGecko service should be provided by the analytics plugin or similar.
 * If not available, the provider will still work with news data only.
 *
 * @example
 * // The provider is automatically called by the framework
 * // No manual invocation needed - just add to plugin.providers array
 */
export const defiNewsProvider: Provider = {
  name: 'DEFI_NEWS',
  description:
    'Provides DeFi market data, global crypto statistics, token information, and real-world crypto news',
  dynamic: true,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    console.log('DEFI_NEWS provider called');

    let defiNewsInfo = '';

    try {
      // Get services - CoinGecko from analytics or similar plugin, NewsData from this plugin
      const coinGeckoService = runtime.getService('COINGECKO_SERVICE') as any;
      const newsDataService = runtime.getService('NEWS_DATA_SERVICE') as NewsDataService;

      if (!newsDataService) {
        console.log('NewsData service not available');
        return {
          data: {},
          values: {},
          text: 'DeFi News service not available.',
        };
      }

      console.log('DeFi News services found, generating report...');

      // Check if a specific token is mentioned in the message
      const messageText = message.content?.text || '';

      defiNewsInfo += `=== DEFI & CRYPTO MARKET REPORT ===\n\n`;

      // Extract symbols dynamically from the message
      let extractedSymbols = extractSymbols(messageText, 'loose');
      extractedSymbols = filterTokenSymbols(extractedSymbols);

      // Also check for token names (bitcoin, ethereum, etc.)
      const namedSymbol = getSymbolFromTokenName(messageText);
      if (namedSymbol && !extractedSymbols.includes(namedSymbol)) {
        extractedSymbols.unshift(namedSymbol); // Add to front
      }

      console.log(`Extracted symbols: ${extractedSymbols.join(', ')}`);

      // If token symbols are detected and services are available, look them up
      if (extractedSymbols.length > 0 && coinGeckoService) {
        // Try to get Birdeye service for symbol lookup
        const birdeyeService = runtime.getService('birdeye') as any;
        const solanaService = runtime.getService('chain_solana') as any;

        if (birdeyeService && solanaService) {
          // Process up to 3 tokens
          for (const detectedSymbol of extractedSymbols.slice(0, 3)) {
            console.log(`Looking up symbol: ${detectedSymbol}`);

            try {
              // Look up token by symbol across all chains
              const options = await birdeyeService.lookupSymbolAllChains(detectedSymbol);
              const exactOptions = options.filter(
                (t: any) => t.symbol.toUpperCase() === detectedSymbol.toUpperCase()
              );

              console.log(
                `Birdeye found ${exactOptions.length} exact matches for ${detectedSymbol}`
              );

              if (exactOptions.length > 0) {
                // Use the first exact match (usually the most popular/main token)
                const tokenOption = exactOptions[0];
                const tokenCA = tokenOption.address;

                console.log(`Using token: ${tokenOption.symbol} at ${tokenCA}`);

                // Verify it's actually a token
                const addressType = await solanaService.getAddressType(tokenCA);

                if (addressType === 'Token') {
                  const tokenData = await getTokenInfoByAddress(
                    coinGeckoService,
                    solanaService,
                    tokenCA,
                    tokenOption.symbol
                  );
                  if (tokenData) {
                    defiNewsInfo += tokenData;
                  }
                } else {
                  console.log(
                    `Address ${tokenCA} is not a Token, it's a ${addressType}`
                  );
                }
              } else {
                console.log(`No exact matches found for ${detectedSymbol}, skipping...`);
              }
            } catch (error) {
              console.log(`Error looking up ${detectedSymbol} via Birdeye:`, error);
            }
          }
        } else {
          // Fallback to CoinGecko ID lookup for major tokens
          console.log('Birdeye or Solana service not available, using CoinGecko fallback');
          for (const detectedSymbol of extractedSymbols.slice(0, 1)) {
            const coingeckoId = getCoinGeckoIdFromSymbol(detectedSymbol);
            if (coingeckoId) {
              const tokenData = await getTokenInfo(coinGeckoService, coingeckoId);
              defiNewsInfo += tokenData;
              break; // Only one token in fallback mode
            }
          }
        }
      }

      // Get global DeFi data (if CoinGecko service is available)
      if (coinGeckoService) {
        const globalDefiData = await getGlobalDefiData(coinGeckoService);
        defiNewsInfo += globalDefiData;

        // Get global crypto market data
        const globalCryptoData = await getGlobalCryptoData(coinGeckoService);
        defiNewsInfo += globalCryptoData;
      } else {
        console.log('CoinGecko service not available, skipping market data');
        defiNewsInfo += '⚠️ Market data unavailable (CoinGecko service not configured)\n\n';
      }

      // Get latest crypto news (always available)
      const latestNews = await getLatestCryptoNews(newsDataService);
      defiNewsInfo += latestNews;
    } catch (error) {
      console.error('Error in DeFi News provider:', error);
      defiNewsInfo = `Error generating DeFi News report: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }

    const data = {
      defiNews: defiNewsInfo,
    };

    const values = {};

    const text = defiNewsInfo + '\n';

    return {
      data,
      values,
      text,
    };
  },
};

/**
 * Extract symbols from text
 * Dynamically extracts token symbols from natural language
 *
 * @param text - The text to extract symbols from
 * @param mode - "strict" only matches $SYMBOL format, "loose" matches various patterns
 * @returns Array of detected symbols
 */
export const extractSymbols = (
  text: string,
  // loose mode will try to extract more symbols but may include false positives
  // strict mode will only extract symbols that are clearly formatted as a symbol using $SOL format
  mode: 'strict' | 'loose' = 'loose'
): string[] => {
  if (!text?.matchAll) return [];
  const symbols = new Set<string>();

  // Match patterns
  const patterns =
    mode === 'strict'
      ? [
          // $SYMBOL format
          /\$([A-Z0-9]{2,10})\b/gi,
          // $SYMBOL format with lowercase
          /\$([a-z0-9]{2,10})\b/gi,
        ]
      : [
          // $SYMBOL format
          /\$([A-Z0-9]{2,10})\b/gi,
          // After articles (a/an)
          /\b(?:a|an)\s+([A-Z0-9]{2,10})\b/gi,
          // Standalone caps
          /\b[A-Z0-9]{2,10}\b/g,
          // Quoted symbols
          /["']([A-Z0-9]{2,10})["']/gi,
          // Common price patterns
          /\b([A-Z0-9]{2,10})\/USD\b/gi,
          /\b([A-Z0-9]{2,10})-USD\b/gi,
        ];

  // Extract all matches
  patterns.forEach((pattern) => {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const symbol = (match[1] || match[0]).toUpperCase();
      symbols.add(symbol);
    }
  });

  return Array.from(symbols);
};

/**
 * Filter extracted symbols to remove common words and validate potential tokens
 */
function filterTokenSymbols(symbols: string[]): string[] {
  // Common words to exclude (not tokens)
  const excludeWords = new Set([
    'THE',
    'AND',
    'FOR',
    'NOT',
    'BUT',
    'GET',
    'SET',
    'CAN',
    'ARE',
    'WAS',
    'HAS',
    'HAD',
    'HER',
    'HIS',
    'OUR',
    'YOU',
    'ALL',
    'OUT',
    'NEW',
    'OLD',
    'NOW',
    'SEE',
    'OWN',
    'TWO',
    'WAY',
    'WHO',
    'ITS',
    'MAY',
    'DAY',
    'USE',
    'USD',
    'EUR',
    'GBP',
    'JPY',
    'CNY', // Fiat currencies
  ]);

  return symbols.filter((symbol) => {
    // Must be 2-10 characters
    if (symbol.length < 2 || symbol.length > 10) return false;

    // Exclude common words
    if (excludeWords.has(symbol)) return false;

    // Should have at least one letter
    if (!/[A-Z]/.test(symbol)) return false;

    return true;
  });
}

/**
 * Map common token names to their symbols
 */
function getSymbolFromTokenName(text: string): string | null {
  const lowerText = text.toLowerCase();

  const tokenNameToSymbol: Record<string, string> = {
    bitcoin: 'BTC',
    ethereum: 'ETH',
    solana: 'SOL',
    cardano: 'ADA',
    polkadot: 'DOT',
    avalanche: 'AVAX',
    polygon: 'MATIC',
    uniswap: 'UNI',
    chainlink: 'LINK',
    'binance coin': 'BNB',
    ripple: 'XRP',
  };

  for (const [name, symbol] of Object.entries(tokenNameToSymbol)) {
    if (lowerText.includes(name)) {
      return symbol;
    }
  }

  return null;
}

/**
 * Get CoinGecko ID from token symbol
 * Fallback mapping for major tokens when Birdeye is not available
 */
function getCoinGeckoIdFromSymbol(symbol: string): string | null {
  const symbolToCoinGeckoId: Record<string, string> = {
    BTC: 'bitcoin',
    ETH: 'ethereum',
    SOL: 'solana',
    ADA: 'cardano',
    DOT: 'polkadot',
    AVAX: 'avalanche',
    MATIC: 'matic-network',
    UNI: 'uniswap',
    LINK: 'chainlink',
    BNB: 'binancecoin',
    XRP: 'ripple',
    USDC: 'usd-coin',
    USDT: 'tether',
  };

  return symbolToCoinGeckoId[symbol.toUpperCase()] || null;
}

/**
 * Get global DeFi market data
 */
async function getGlobalDefiData(coinGeckoService: any): Promise<string> {
  let defiInfo = '📊 GLOBAL DEFI MARKET DATA:\n\n';

  try {
    const defiData = await coinGeckoService.getGlobalDefiData();

    defiInfo += `💰 DeFi Market Cap: $${parseFloat(defiData.defi_market_cap).toLocaleString()}\n`;
    defiInfo += `💎 ETH Market Cap: $${parseFloat(defiData.eth_market_cap).toLocaleString()}\n`;
    defiInfo += `📈 DeFi/ETH Ratio: ${parseFloat(defiData.defi_to_eth_ratio).toFixed(4)}\n`;
    defiInfo += `📊 24h Trading Volume: $${parseFloat(defiData.trading_volume_24h).toLocaleString()}\n`;
    defiInfo += `🎯 DeFi Dominance: ${parseFloat(defiData.defi_dominance).toFixed(2)}%\n`;
    defiInfo += `👑 Top DeFi Coin: ${defiData.top_coin_name} (${defiData.top_coin_defi_dominance.toFixed(2)}% dominance)\n\n`;
  } catch (error) {
    console.error('Error fetching global DeFi data:', error);
    defiInfo += 'Error fetching DeFi data. Please try again later.\n\n';
  }

  return defiInfo;
}

/**
 * Get global crypto market data
 */
async function getGlobalCryptoData(coinGeckoService: any): Promise<string> {
  let cryptoInfo = '🌐 GLOBAL CRYPTO MARKET DATA:\n\n';

  try {
    const cryptoData = await coinGeckoService.getGlobalCryptoData();

    cryptoInfo += `🪙 Active Cryptocurrencies: ${cryptoData.active_cryptocurrencies.toLocaleString()}\n`;
    cryptoInfo += `💱 Active Markets: ${cryptoData.markets.toLocaleString()}\n`;
    cryptoInfo += `💰 Total Market Cap: $${(cryptoData.total_market_cap.usd / 1e9).toFixed(2)}B\n`;
    cryptoInfo += `📊 24h Volume: $${(cryptoData.total_volume.usd / 1e9).toFixed(2)}B\n`;
    cryptoInfo += `📈 24h Market Cap Change: ${cryptoData.market_cap_change_percentage_24h_usd.toFixed(2)}%\n`;

    if (cryptoData.market_cap_percentage) {
      cryptoInfo += '\n🏆 MARKET DOMINANCE:\n';
      const topCoins = Object.entries(cryptoData.market_cap_percentage)
        .sort((a, b) => (b[1] as number) - (a[1] as number))
        .slice(0, 5) as [string, number][];
      topCoins.forEach(([coin, percentage]) => {
        cryptoInfo += `   • ${coin.toUpperCase()}: ${percentage.toFixed(2)}%\n`;
      });
    }

    cryptoInfo += '\n';
  } catch (error) {
    console.error('Error fetching global crypto data:', error);
    cryptoInfo += 'Error fetching crypto market data. Please try again later.\n\n';
  }

  return cryptoInfo;
}

/**
 * Get latest crypto news
 */
async function getLatestCryptoNews(newsDataService: NewsDataService): Promise<string> {
  let newsInfo = '📰 LATEST CRYPTO NEWS:\n\n';

  try {
    const articles = await newsDataService.getLatestNews({
      limit: 5,
    });

    if (articles.length === 0) {
      newsInfo += 'No recent news articles available.\n\n';
      return newsInfo;
    }

    articles.forEach((article, index) => {
      newsInfo += `${index + 1}. ${article.title}\n`;

      if (article.description) {
        const shortDesc = article.description.substring(0, 100);
        newsInfo += `   ${shortDesc}${article.description.length > 100 ? '...' : ''}\n`;
      }

      if (article.pubDate) {
        const pubDate = new Date(article.pubDate);
        newsInfo += `   📅 ${pubDate.toLocaleDateString()} | 📰 ${article.source_id}\n`;
      }

      if (article.link) {
        newsInfo += `   🔗 ${article.link}\n`;
      }

      newsInfo += '\n';
    });
  } catch (error) {
    console.error('Error fetching latest crypto news:', error);
    newsInfo += 'Error fetching news. Please try again later.\n\n';
  }

  return newsInfo;
}

/**
 * Get token information by contract address
 * Uses Birdeye + CoinGecko to fetch comprehensive token data
 */
async function getTokenInfoByAddress(
  coinGeckoService: any,
  solanaService: any,
  tokenAddress: string,
  symbol: string
): Promise<string | null> {
  let tokenInfo = `📊 TOKEN INFORMATION:\n\n`;

  try {
    // Import PublicKey if needed
    const { PublicKey } = await import('@solana/web3.js');

    // Get token symbol from Solana (for verification)
    let tokenSymbol = symbol;
    try {
      const onChainSymbol = await solanaService.getTokenSymbol(new PublicKey(tokenAddress));
      if (onChainSymbol) {
        tokenSymbol = onChainSymbol;
      }
    } catch (error) {
      console.log('Could not fetch on-chain symbol, using provided:', symbol);
    }

    console.log(`Fetching CoinGecko data for ${tokenSymbol} at ${tokenAddress}`);

    // Try to search CoinGecko by symbol
    let coinData = null;
    const searchResults = await coinGeckoService.searchCoin(tokenSymbol);

    if (searchResults && searchResults.length > 0) {
      // Try to find exact match by Solana platform address
      const solanaMatch = searchResults.find(
        (coin: any) =>
          coin.platforms?.solana?.toLowerCase() === tokenAddress.toLowerCase()
      );

      if (solanaMatch) {
        console.log(`Found exact Solana platform match: ${solanaMatch.id}`);
        coinData = await coinGeckoService.getCoinData(solanaMatch.id);
      } else {
        // Use first result as fallback
        console.log(`Using first search result: ${searchResults[0].id}`);
        coinData = await coinGeckoService.getCoinData(searchResults[0].id);
      }
    }

    if (!coinData) {
      tokenInfo += `🪙 Token: ${tokenSymbol}\n`;
      tokenInfo += `📍 Address: ${tokenAddress}\n`;
      tokenInfo += `⚠️ Detailed market data not available on CoinGecko\n\n`;
      return tokenInfo;
    }

    // Format comprehensive token data
    tokenInfo += `🪙 ${coinData.name} (${coinData.symbol.toUpperCase()})\n`;
    tokenInfo += `📍 Contract Address: ${tokenAddress}\n\n`;

    if (coinData.market_data) {
      const md = coinData.market_data;
      tokenInfo += '💵 PRICE INFORMATION:\n';
      if (md.current_price?.usd) {
        tokenInfo += `   Current Price: $${md.current_price.usd.toLocaleString()}\n`;
      }
      if (md.market_cap?.usd) {
        tokenInfo += `   Market Cap: $${(md.market_cap.usd / 1e9).toFixed(2)}B\n`;
      }
      if (md.total_volume?.usd) {
        tokenInfo += `   24h Volume: $${(md.total_volume.usd / 1e9).toFixed(2)}B\n`;
      }
      if (md.market_cap_rank) {
        tokenInfo += `   Market Cap Rank: #${md.market_cap_rank}\n`;
      }

      tokenInfo += '\n📈 PRICE CHANGES:\n';
      if (md.price_change_percentage_24h !== undefined) {
        const emoji = md.price_change_percentage_24h >= 0 ? '📈' : '📉';
        tokenInfo += `   ${emoji} 24h: ${md.price_change_percentage_24h.toFixed(2)}%\n`;
      }
      if (md.price_change_percentage_7d !== undefined) {
        const emoji = md.price_change_percentage_7d >= 0 ? '📈' : '📉';
        tokenInfo += `   ${emoji} 7d: ${md.price_change_percentage_7d.toFixed(2)}%\n`;
      }
      if (md.price_change_percentage_30d !== undefined) {
        const emoji = md.price_change_percentage_30d >= 0 ? '📈' : '📉';
        tokenInfo += `   ${emoji} 30d: ${md.price_change_percentage_30d.toFixed(2)}%\n`;
      }

      if (md.high_24h?.usd && md.low_24h?.usd) {
        tokenInfo += '\n📊 24H RANGE:\n';
        tokenInfo += `   High: $${md.high_24h.usd.toLocaleString()}\n`;
        tokenInfo += `   Low: $${md.low_24h.usd.toLocaleString()}\n`;
      }
    }

    if (coinData.community_data) {
      const cd = coinData.community_data;
      if (cd.twitter_followers || cd.reddit_subscribers || cd.telegram_channel_user_count) {
        tokenInfo += '\n👥 COMMUNITY:\n';
        if (cd.twitter_followers)
          tokenInfo += `   🐦 Twitter: ${cd.twitter_followers.toLocaleString()} followers\n`;
        if (cd.reddit_subscribers)
          tokenInfo += `   🔴 Reddit: ${cd.reddit_subscribers.toLocaleString()} subscribers\n`;
        if (cd.telegram_channel_user_count)
          tokenInfo += `   ✈️ Telegram: ${cd.telegram_channel_user_count.toLocaleString()} members\n`;
      }
    }

    if (coinData.developer_data) {
      const dd = coinData.developer_data;
      if (dd.stars || dd.forks) {
        tokenInfo += '\n💻 DEVELOPER ACTIVITY:\n';
        if (dd.stars) tokenInfo += `   ⭐ GitHub Stars: ${dd.stars.toLocaleString()}\n`;
        if (dd.forks) tokenInfo += `   🔱 Forks: ${dd.forks.toLocaleString()}\n`;
      }
    }

    tokenInfo += '\n';
  } catch (error) {
    console.error('Error fetching token info by address:', error);
    return null;
  }

  return tokenInfo;
}

/**
 * Get token information
 * This is a helper function that can be used for specific token queries
 */
export async function getTokenInfo(coinGeckoService: any, tokenId: string): Promise<string> {
  let tokenInfo = `📊 TOKEN INFORMATION:\n\n`;

  try {
    const tokenData = await coinGeckoService.getCoinData(tokenId);

    tokenInfo += `🪙 ${tokenData.name} (${tokenData.symbol.toUpperCase()})\n\n`;

    if (tokenData.market_data) {
      const md = tokenData.market_data;
      tokenInfo += '💵 PRICE INFORMATION:\n';
      if (md.current_price?.usd) {
        tokenInfo += `   Current Price: $${md.current_price.usd.toLocaleString()}\n`;
      }
      if (md.market_cap?.usd) {
        tokenInfo += `   Market Cap: $${(md.market_cap.usd / 1e9).toFixed(2)}B\n`;
      }
      if (md.total_volume?.usd) {
        tokenInfo += `   24h Volume: $${(md.total_volume.usd / 1e9).toFixed(2)}B\n`;
      }

      tokenInfo += '\n📈 PRICE CHANGES:\n';
      if (md.price_change_percentage_24h !== undefined) {
        const emoji = md.price_change_percentage_24h >= 0 ? '📈' : '📉';
        tokenInfo += `   ${emoji} 24h: ${md.price_change_percentage_24h.toFixed(2)}%\n`;
      }
      if (md.price_change_percentage_7d !== undefined) {
        const emoji = md.price_change_percentage_7d >= 0 ? '📈' : '📉';
        tokenInfo += `   ${emoji} 7d: ${md.price_change_percentage_7d.toFixed(2)}%\n`;
      }
      if (md.price_change_percentage_30d !== undefined) {
        const emoji = md.price_change_percentage_30d >= 0 ? '📈' : '📉';
        tokenInfo += `   ${emoji} 30d: ${md.price_change_percentage_30d.toFixed(2)}%\n`;
      }
    }

    if (tokenData.community_data) {
      const cd = tokenData.community_data;
      if (cd.twitter_followers || cd.reddit_subscribers) {
        tokenInfo += '\n👥 COMMUNITY:\n';
        if (cd.twitter_followers)
          tokenInfo += `   🐦 Twitter: ${cd.twitter_followers.toLocaleString()} followers\n`;
        if (cd.reddit_subscribers)
          tokenInfo += `   🔴 Reddit: ${cd.reddit_subscribers.toLocaleString()} subscribers\n`;
      }
    }

    tokenInfo += '\n';
  } catch (error) {
    console.error('Error fetching token info:', error);
    tokenInfo += 'Error fetching token data. Please try again later.\n\n';
  }

  return tokenInfo;
}

