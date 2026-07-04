/**
 * `DEFI_NEWS` provider: renders a DeFi/crypto market report into planner
 * context — global DeFi and crypto market stats (needs `COINGECKO_SERVICE`),
 * latest Brave New Coin RSS headlines (always available), and, when a token
 * symbol/name is detected in the message, per-token data resolved via
 * Birdeye + on-chain lookup when available, falling back to a hardcoded
 * symbol-to-CoinGecko-id table for a short list of major tokens.
 */
import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { NewsDataService } from "../services/newsDataService";

interface CoinGeckoDefiData {
  defi_market_cap: string;
  eth_market_cap: string;
  defi_to_eth_ratio: string;
  trading_volume_24h: string;
  defi_dominance: string;
  top_coin_name: string;
  top_coin_defi_dominance: number;
}

interface CoinGeckoGlobalCryptoData {
  active_cryptocurrencies: number;
  markets: number;
  total_market_cap: { usd: number };
  total_volume: { usd: number };
  market_cap_change_percentage_24h_usd: number;
  market_cap_percentage?: Record<string, number>;
}

interface CoinGeckoSearchResult {
  id: string;
  platforms?: { solana?: string };
}

interface CoinGeckoCoinData {
  name: string;
  symbol: string;
  market_cap_rank?: number;
  market_data?: {
    current_price?: { usd?: number };
    market_cap?: { usd?: number };
    total_volume?: { usd?: number };
    high_24h?: { usd?: number };
    low_24h?: { usd?: number };
    price_change_percentage_24h?: number;
    price_change_percentage_7d?: number;
    price_change_percentage_30d?: number;
  };
  community_data?: {
    twitter_followers?: number;
    reddit_subscribers?: number;
    telegram_channel_user_count?: number;
  };
  developer_data?: {
    forks?: number;
    stars?: number;
  };
}

interface CoinGeckoService {
  getGlobalDefiData(): Promise<CoinGeckoDefiData>;
  getGlobalCryptoData(): Promise<CoinGeckoGlobalCryptoData>;
  searchCoin(symbol: string): Promise<CoinGeckoSearchResult[]>;
  getCoinData(tokenId: string): Promise<CoinGeckoCoinData>;
}

interface BirdeyeSymbolOption {
  symbol: string;
  address: string;
}

interface BirdeyeLookupService {
  lookupSymbolAllChains(symbol: string): Promise<BirdeyeSymbolOption[]>;
}

interface SolanaTokenInfoService {
  getAddressType(address: string): Promise<string>;
  getTokenSymbol(publicKey: object): Promise<string | null | undefined>;
}
const DEFI_NEWS_TEXT_LIMIT = 4000;

export const defiNewsProvider: Provider = {
  name: "DEFI_NEWS",
  description:
    "Provides DeFi market data, global crypto statistics, token information, and real-world crypto news",
  descriptionCompressed:
    "DeFi market data, crypto stats, token info, crypto news",
  dynamic: true,
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },
  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    let defiNewsInfo = "";

    try {
      const coinGeckoService = runtime.getService(
        "COINGECKO_SERVICE",
      ) as CoinGeckoService | null;
      const newsDataService = runtime.getService(
        "NEWS_DATA_SERVICE",
      ) as NewsDataService;

      if (!newsDataService) {
        return {
          data: {},
          values: {},
          text: "DeFi News service not available.",
        };
      }

      const messageText = message.content.text || "";

      defiNewsInfo += `=== DEFI & CRYPTO MARKET REPORT ===\n\n`;

      let extractedSymbols = extractSymbols(messageText, "loose");
      extractedSymbols = filterTokenSymbols(extractedSymbols);

      const namedSymbol = getSymbolFromTokenName(messageText);
      if (namedSymbol && !extractedSymbols.includes(namedSymbol)) {
        extractedSymbols.unshift(namedSymbol); // Add to front
      }

      if (extractedSymbols.length > 0 && coinGeckoService) {
        const birdeyeService = runtime.getService(
          "birdeye",
        ) as BirdeyeLookupService | null;
        const solanaService = runtime.getService(
          "chain_solana",
        ) as SolanaTokenInfoService | null;

        if (birdeyeService && solanaService) {
          for (const detectedSymbol of extractedSymbols.slice(0, 3)) {
            try {
              const options =
                await birdeyeService.lookupSymbolAllChains(detectedSymbol);
              const exactOptions = options.filter(
                (t) => t.symbol.toUpperCase() === detectedSymbol.toUpperCase(),
              );

              if (exactOptions.length > 0) {
                // Use the first exact match (usually the most popular/main token)
                const tokenOption = exactOptions[0];
                const tokenCA = tokenOption.address;

                const addressType = await solanaService.getAddressType(tokenCA);

                if (addressType === "Token") {
                  const tokenData = await getTokenInfoByAddress(
                    coinGeckoService,
                    solanaService,
                    tokenCA,
                    tokenOption.symbol,
                  );
                  if (tokenData) {
                    defiNewsInfo += tokenData;
                  }
                }
              }
            } catch (error) {
              runtime.logger.warn(
                `[DEFI_NEWS] error looking up ${detectedSymbol} via Birdeye: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        } else {
          for (const detectedSymbol of extractedSymbols.slice(0, 1)) {
            const coingeckoId = getCoinGeckoIdFromSymbol(detectedSymbol);
            if (coingeckoId) {
              const tokenData = await getTokenInfo(
                coinGeckoService,
                coingeckoId,
              );
              defiNewsInfo += tokenData;
              break; // Only one token in fallback mode
            }
          }
        }
      }

      if (coinGeckoService) {
        const globalDefiData = await getGlobalDefiData(coinGeckoService);
        defiNewsInfo += globalDefiData;

        const globalCryptoData = await getGlobalCryptoData(coinGeckoService);
        defiNewsInfo += globalCryptoData;
      } else {
        defiNewsInfo +=
          "⚠️ Market data unavailable (CoinGecko service not configured)\n\n";
      }

      const latestNews = await getLatestCryptoNews(newsDataService);
      defiNewsInfo += latestNews;
    } catch (error) {
      console.error("Error in DeFi News provider:", error);
      defiNewsInfo = `Error generating DeFi News report: ${error instanceof Error ? error.message : "Unknown error"}`;
    }

    const data = {
      defiNews: defiNewsInfo,
    };

    const values = {};

    const text = `${defiNewsInfo}\n`.slice(0, DEFI_NEWS_TEXT_LIMIT);

    return {
      data,
      values,
      text,
    };
  },
};

/** Extracts candidate token symbols from free-form text; `mode` controls strictness (see below). */
export const extractSymbols = (
  text: string,
  // loose mode will try to extract more symbols but may include false positives
  // strict mode will only extract symbols that are clearly formatted as a symbol using $SOL format
  mode: "strict" | "loose" = "loose",
): string[] => {
  if (!text.matchAll) return [];
  const symbols = new Set<string>();

  const patterns =
    mode === "strict"
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

  patterns.forEach((pattern) => {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const symbol = (match[1] || match[0]).toUpperCase();
      symbols.add(symbol);
    }
  });

  return Array.from(symbols);
};

function filterTokenSymbols(symbols: string[]): string[] {
  // Common English words and fiat currency codes that match the symbol
  // regexes but aren't tokens.
  const excludeWords = new Set([
    "THE",
    "AND",
    "FOR",
    "NOT",
    "BUT",
    "GET",
    "SET",
    "CAN",
    "ARE",
    "WAS",
    "HAS",
    "HAD",
    "HER",
    "HIS",
    "OUR",
    "YOU",
    "ALL",
    "OUT",
    "NEW",
    "OLD",
    "NOW",
    "SEE",
    "OWN",
    "TWO",
    "WAY",
    "WHO",
    "ITS",
    "MAY",
    "DAY",
    "USE",
    "USD",
    "EUR",
    "GBP",
    "JPY",
    "CNY", // Fiat currencies
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

function getSymbolFromTokenName(text: string): string | null {
  const lowerText = text.toLowerCase();

  const tokenNameToSymbol: Record<string, string> = {
    bitcoin: "BTC",
    ethereum: "ETH",
    solana: "SOL",
    cardano: "ADA",
    polkadot: "DOT",
    avalanche: "AVAX",
    polygon: "MATIC",
    uniswap: "UNI",
    chainlink: "LINK",
    "binance coin": "BNB",
    ripple: "XRP",
  };

  for (const [name, symbol] of Object.entries(tokenNameToSymbol)) {
    if (lowerText.includes(name)) {
      return symbol;
    }
  }

  return null;
}

/** Fallback symbol-to-CoinGecko-id mapping for major tokens, used when Birdeye is unavailable. */
function getCoinGeckoIdFromSymbol(symbol: string): string | null {
  const symbolToCoinGeckoId: Record<string, string> = {
    BTC: "bitcoin",
    ETH: "ethereum",
    SOL: "solana",
    ADA: "cardano",
    DOT: "polkadot",
    AVAX: "avalanche",
    MATIC: "matic-network",
    UNI: "uniswap",
    LINK: "chainlink",
    BNB: "binancecoin",
    XRP: "ripple",
    USDC: "usd-coin",
    USDT: "tether",
  };

  return symbolToCoinGeckoId[symbol.toUpperCase()] || null;
}

async function getGlobalDefiData(
  coinGeckoService: CoinGeckoService,
): Promise<string> {
  let defiInfo = "📊 GLOBAL DEFI MARKET DATA:\n\n";

  try {
    const defiData = await coinGeckoService.getGlobalDefiData();

    defiInfo += `💰 DeFi Market Cap: $${parseFloat(defiData.defi_market_cap).toLocaleString()}\n`;
    defiInfo += `💎 ETH Market Cap: $${parseFloat(defiData.eth_market_cap).toLocaleString()}\n`;
    defiInfo += `📈 DeFi/ETH Ratio: ${parseFloat(defiData.defi_to_eth_ratio).toFixed(4)}\n`;
    defiInfo += `📊 24h Trading Volume: $${parseFloat(defiData.trading_volume_24h).toLocaleString()}\n`;
    defiInfo += `🎯 DeFi Dominance: ${parseFloat(defiData.defi_dominance).toFixed(2)}%\n`;
    defiInfo += `👑 Top DeFi Coin: ${defiData.top_coin_name} (${defiData.top_coin_defi_dominance.toFixed(2)}% dominance)\n\n`;
  } catch (error) {
    console.error("Error fetching global DeFi data:", error);
    defiInfo += "Error fetching DeFi data. Please try again later.\n\n";
  }

  return defiInfo;
}

async function getGlobalCryptoData(
  coinGeckoService: CoinGeckoService,
): Promise<string> {
  let cryptoInfo = "🌐 GLOBAL CRYPTO MARKET DATA:\n\n";

  try {
    const cryptoData = await coinGeckoService.getGlobalCryptoData();

    cryptoInfo += `🪙 Active Cryptocurrencies: ${cryptoData.active_cryptocurrencies.toLocaleString()}\n`;
    cryptoInfo += `💱 Active Markets: ${cryptoData.markets.toLocaleString()}\n`;
    cryptoInfo += `💰 Total Market Cap: $${(cryptoData.total_market_cap.usd / 1e9).toFixed(2)}B\n`;
    cryptoInfo += `📊 24h Volume: $${(cryptoData.total_volume.usd / 1e9).toFixed(2)}B\n`;
    cryptoInfo += `📈 24h Market Cap Change: ${cryptoData.market_cap_change_percentage_24h_usd.toFixed(2)}%\n`;

    if (cryptoData.market_cap_percentage) {
      cryptoInfo += "\n🏆 MARKET DOMINANCE:\n";
      const topCoins = Object.entries(cryptoData.market_cap_percentage)
        .sort((a, b) => (b[1] as number) - (a[1] as number))
        .slice(0, 5) as [string, number][];
      topCoins.forEach(([coin, percentage]) => {
        cryptoInfo += `   • ${coin.toUpperCase()}: ${percentage.toFixed(2)}%\n`;
      });
    }

    cryptoInfo += "\n";
  } catch (error) {
    console.error("Error fetching global crypto data:", error);
    cryptoInfo +=
      "Error fetching crypto market data. Please try again later.\n\n";
  }

  return cryptoInfo;
}

async function getLatestCryptoNews(
  newsDataService: NewsDataService,
): Promise<string> {
  let newsInfo = "📰 LATEST CRYPTO NEWS:\n\n";

  try {
    const articles = await newsDataService.getLatestNews({
      limit: 5,
    });

    if (articles.length === 0) {
      newsInfo += "No recent news articles available.\n\n";
      return newsInfo;
    }

    articles.forEach((article, index) => {
      newsInfo += `${index + 1}. ${article.title}\n`;

      if (article.description) {
        const shortDesc = article.description.substring(0, 100);
        newsInfo += `   ${shortDesc}${article.description.length > 100 ? "..." : ""}\n`;
      }

      if (article.pubDate) {
        const pubDate = new Date(article.pubDate);
        newsInfo += `   📅 ${pubDate.toLocaleDateString()} | 📰 ${article.source_id}\n`;
      }

      if (article.link) {
        newsInfo += `   🔗 ${article.link}\n`;
      }

      newsInfo += "\n";
    });
  } catch (error) {
    console.error("Error fetching latest crypto news:", error);
    newsInfo += "Error fetching news. Please try again later.\n\n";
  }

  return newsInfo;
}

async function getTokenInfoByAddress(
  coinGeckoService: CoinGeckoService,
  solanaService: SolanaTokenInfoService,
  tokenAddress: string,
  symbol: string,
): Promise<string | null> {
  let tokenInfo = `📊 TOKEN INFORMATION:\n\n`;

  try {
    const { PublicKey } = await import("@solana/web3.js");

    let tokenSymbol = symbol;
    try {
      const onChainSymbol = await solanaService.getTokenSymbol(
        new PublicKey(tokenAddress),
      );
      if (onChainSymbol) {
        tokenSymbol = onChainSymbol;
      }
    } catch (_error) {
      // fall back to provided symbol when on-chain lookup fails
    }

    let coinData: CoinGeckoCoinData | null = null;
    const searchResults = await coinGeckoService.searchCoin(tokenSymbol);

    if (searchResults && searchResults.length > 0) {
      const solanaMatch = searchResults.find(
        (coin) =>
          coin.platforms?.solana?.toLowerCase() === tokenAddress.toLowerCase(),
      );

      if (solanaMatch) {
        coinData = await coinGeckoService.getCoinData(solanaMatch.id);
      } else {
        coinData = await coinGeckoService.getCoinData(searchResults[0].id);
      }
    }

    if (!coinData) {
      tokenInfo += `🪙 Token: ${tokenSymbol}\n`;
      tokenInfo += `📍 Address: ${tokenAddress}\n`;
      tokenInfo += `⚠️ Detailed market data not available on CoinGecko\n\n`;
      return tokenInfo;
    }

    tokenInfo += `🪙 ${coinData.name} (${coinData.symbol.toUpperCase()})\n`;
    tokenInfo += `📍 Contract Address: ${tokenAddress}\n\n`;

    if (coinData.market_data) {
      const md = coinData.market_data;
      tokenInfo += "💵 PRICE INFORMATION:\n";
      if (md.current_price?.usd) {
        tokenInfo += `   Current Price: $${md.current_price.usd.toLocaleString()}\n`;
      }
      if (md.market_cap?.usd) {
        tokenInfo += `   Market Cap: $${(md.market_cap.usd / 1e9).toFixed(2)}B\n`;
      }
      if (md.total_volume?.usd) {
        tokenInfo += `   24h Volume: $${(md.total_volume.usd / 1e9).toFixed(2)}B\n`;
      }
      if (coinData.market_cap_rank) {
        tokenInfo += `   Market Cap Rank: #${coinData.market_cap_rank}\n`;
      }

      tokenInfo += "\n📈 PRICE CHANGES:\n";
      if (md.price_change_percentage_24h !== undefined) {
        const emoji = md.price_change_percentage_24h >= 0 ? "📈" : "📉";
        tokenInfo += `   ${emoji} 24h: ${md.price_change_percentage_24h.toFixed(2)}%\n`;
      }
      if (md.price_change_percentage_7d !== undefined) {
        const emoji = md.price_change_percentage_7d >= 0 ? "📈" : "📉";
        tokenInfo += `   ${emoji} 7d: ${md.price_change_percentage_7d.toFixed(2)}%\n`;
      }
      if (md.price_change_percentage_30d !== undefined) {
        const emoji = md.price_change_percentage_30d >= 0 ? "📈" : "📉";
        tokenInfo += `   ${emoji} 30d: ${md.price_change_percentage_30d.toFixed(2)}%\n`;
      }

      if (md.high_24h?.usd && md.low_24h?.usd) {
        tokenInfo += "\n📊 24H RANGE:\n";
        tokenInfo += `   High: $${md.high_24h.usd.toLocaleString()}\n`;
        tokenInfo += `   Low: $${md.low_24h.usd.toLocaleString()}\n`;
      }
    }

    if (coinData.community_data) {
      const cd = coinData.community_data;
      if (
        cd.twitter_followers ||
        cd.reddit_subscribers ||
        cd.telegram_channel_user_count
      ) {
        tokenInfo += "\n👥 COMMUNITY:\n";
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
        tokenInfo += "\n💻 DEVELOPER ACTIVITY:\n";
        if (dd.stars)
          tokenInfo += `   ⭐ GitHub Stars: ${dd.stars.toLocaleString()}\n`;
        if (dd.forks)
          tokenInfo += `   🔱 Forks: ${dd.forks.toLocaleString()}\n`;
      }
    }

    tokenInfo += "\n";
  } catch (error) {
    console.error("Error fetching token info by address:", error);
    return null;
  }

  return tokenInfo;
}

export async function getTokenInfo(
  coinGeckoService: CoinGeckoService,
  tokenId: string,
): Promise<string> {
  let tokenInfo = `📊 TOKEN INFORMATION:\n\n`;

  try {
    const tokenData = await coinGeckoService.getCoinData(tokenId);

    tokenInfo += `🪙 ${tokenData.name} (${tokenData.symbol.toUpperCase()})\n\n`;

    if (tokenData.market_data) {
      const md = tokenData.market_data;
      tokenInfo += "💵 PRICE INFORMATION:\n";
      if (md.current_price?.usd) {
        tokenInfo += `   Current Price: $${md.current_price.usd.toLocaleString()}\n`;
      }
      if (md.market_cap?.usd) {
        tokenInfo += `   Market Cap: $${(md.market_cap.usd / 1e9).toFixed(2)}B\n`;
      }
      if (md.total_volume?.usd) {
        tokenInfo += `   24h Volume: $${(md.total_volume.usd / 1e9).toFixed(2)}B\n`;
      }

      tokenInfo += "\n📈 PRICE CHANGES:\n";
      if (md.price_change_percentage_24h !== undefined) {
        const emoji = md.price_change_percentage_24h >= 0 ? "📈" : "📉";
        tokenInfo += `   ${emoji} 24h: ${md.price_change_percentage_24h.toFixed(2)}%\n`;
      }
      if (md.price_change_percentage_7d !== undefined) {
        const emoji = md.price_change_percentage_7d >= 0 ? "📈" : "📉";
        tokenInfo += `   ${emoji} 7d: ${md.price_change_percentage_7d.toFixed(2)}%\n`;
      }
      if (md.price_change_percentage_30d !== undefined) {
        const emoji = md.price_change_percentage_30d >= 0 ? "📈" : "📉";
        tokenInfo += `   ${emoji} 30d: ${md.price_change_percentage_30d.toFixed(2)}%\n`;
      }
    }

    if (tokenData.community_data) {
      const cd = tokenData.community_data;
      if (cd.twitter_followers || cd.reddit_subscribers) {
        tokenInfo += "\n👥 COMMUNITY:\n";
        if (cd.twitter_followers)
          tokenInfo += `   🐦 Twitter: ${cd.twitter_followers.toLocaleString()} followers\n`;
        if (cd.reddit_subscribers)
          tokenInfo += `   🔴 Reddit: ${cd.reddit_subscribers.toLocaleString()} subscribers\n`;
      }
    }

    tokenInfo += "\n";
  } catch (error) {
    console.error("Error fetching token info:", error);
    tokenInfo += "Error fetching token data. Please try again later.\n\n";
  }

  return tokenInfo;
}
