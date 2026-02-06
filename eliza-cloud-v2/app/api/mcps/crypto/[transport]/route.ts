import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

interface CoinGeckoPriceData {
  [coinId: string]: {
    [currency: string]: number;
    usd_24h_change?: number;
    usd_market_cap?: number;
    usd_24h_vol?: number;
  };
}

interface CoinGeckoMarketData {
  id: string;
  symbol: string;
  name: string;
  image?: { large?: string };
  market_data?: {
    current_price?: { usd?: number };
    market_cap?: { usd?: number };
    market_cap_rank?: number;
    fully_diluted_valuation?: { usd?: number };
    total_volume?: { usd?: number };
    high_24h?: { usd?: number };
    low_24h?: { usd?: number };
    price_change_24h?: number;
    price_change_percentage_24h?: number;
    price_change_percentage_7d?: number;
    price_change_percentage_30d?: number;
    market_cap_change_24h?: number;
    market_cap_change_percentage_24h?: number;
    circulating_supply?: number;
    total_supply?: number;
    max_supply?: number;
    ath?: { usd?: number };
    ath_change_percentage?: { usd?: number };
    ath_date?: { usd?: string };
    atl?: { usd?: number };
    atl_change_percentage?: { usd?: number };
    atl_date?: { usd?: string };
  };
}

interface CoinGeckoTrendingResponse {
  coins?: Array<{
    item: {
      id: string;
      coin_id?: number;
      name: string;
      symbol: string;
      market_cap_rank?: number;
      thumb?: string;
      small?: string;
      large?: string;
      price_btc?: number;
      score?: number;
      data?: {
        price?: number;
        price_change_percentage_24h?: { usd?: number };
        market_cap?: string;
        total_volume?: string;
      };
    };
  }>;
}

export const maxDuration = 300;

// CoinGecko API base URL (free tier)
const COINGECKO_API = "https://api.coingecko.com/api/v3";

// Cache for price data (5 minute TTL)
const priceCache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchWithCache(url: string, cacheKey: string) {
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `CoinGecko API error: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  priceCache.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}

// Popular coin ID mappings for convenience
const COIN_ALIASES: Record<string, string> = {
  btc: "bitcoin",
  eth: "ethereum",
  sol: "solana",
  doge: "dogecoin",
  xrp: "ripple",
  ada: "cardano",
  dot: "polkadot",
  matic: "matic-network",
  link: "chainlink",
  uni: "uniswap",
  avax: "avalanche-2",
  atom: "cosmos",
  near: "near",
  apt: "aptos",
  arb: "arbitrum",
  op: "optimism",
  sui: "sui",
  sei: "sei-network",
  inj: "injective-protocol",
  usdt: "tether",
  usdc: "usd-coin",
  bnb: "binancecoin",
  shib: "shiba-inu",
  pepe: "pepe",
  bonk: "bonk",
  wif: "dogwifcoin",
};

function resolveCoinId(input: string): string {
  const normalized = input.toLowerCase().trim();
  return COIN_ALIASES[normalized] || normalized;
}

function formatLargeNumber(num: number): string {
  if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
  return num.toFixed(2);
}

// Create MCP handler with crypto tools
const handler = createMcpHandler(
  (server) => {
    // Tool 1: Get Price - Get current price for a cryptocurrency
    server.tool(
      "get_price",
      "Get the current price of a cryptocurrency in your preferred currency. " +
        "Supports thousands of coins including Bitcoin (BTC), Ethereum (ETH), Solana (SOL), etc. " +
        "You can use either the full name (bitcoin) or symbol (btc).",
      {
        coin: z
          .string()
          .describe(
            "The cryptocurrency name or symbol (e.g., 'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol')",
          ),
        currency: z
          .string()
          .optional()
          .default("usd")
          .describe(
            "The fiat currency for price (e.g., 'usd', 'eur', 'gbp'). Defaults to USD.",
          ),
      },
      async ({ coin, currency = "usd" }) => {
        try {
          const coinId = resolveCoinId(coin);
          const cacheKey = `price:${coinId}:${currency}`;

          const data = (await fetchWithCache(
            `${COINGECKO_API}/simple/price?ids=${coinId}&vs_currencies=${currency}&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`,
            cacheKey,
          )) as CoinGeckoPriceData;

          if (!data[coinId]) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      error: `Cryptocurrency "${coin}" not found. Try using the full name (e.g., "bitcoin") or check the spelling.`,
                      suggestion:
                        "Use list_trending to see popular cryptocurrencies.",
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          const coinData = data[coinId];
          const price = coinData[currency];
          const change24h =
            coinData[`${currency}_24h_change`] || coinData.usd_24h_change;
          const marketCap =
            coinData[`${currency}_market_cap`] || coinData.usd_market_cap;
          const volume24h =
            coinData[`${currency}_24h_vol`] || coinData.usd_24h_vol;

          const response = {
            coin: coinId,
            symbol: coin.toUpperCase(),
            price: {
              value: price,
              currency: currency.toUpperCase(),
              formatted: `${currency.toUpperCase()} ${price?.toLocaleString(
                undefined,
                {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: price < 1 ? 8 : 2,
                },
              )}`,
            },
            change24h: change24h
              ? {
                  percent: change24h,
                  formatted: `${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%`,
                  direction: change24h >= 0 ? "up" : "down",
                }
              : null,
            marketCap: marketCap
              ? {
                  value: marketCap,
                  formatted: `${currency.toUpperCase()} ${formatLargeNumber(marketCap)}`,
                }
              : null,
            volume24h: volume24h
              ? {
                  value: volume24h,
                  formatted: `${currency.toUpperCase()} ${formatLargeNumber(volume24h)}`,
                }
              : null,
            timestamp: new Date().toISOString(),
            source: "CoinGecko",
          };

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(response, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error:
                      error instanceof Error
                        ? error.message
                        : "Failed to fetch price",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    );

    // Tool 2: Get Market Data - Get detailed market data for a coin
    server.tool(
      "get_market_data",
      "Get comprehensive market data for a cryptocurrency including price, volume, " +
        "market cap, supply information, all-time high/low, and price change percentages.",
      {
        coin: z
          .string()
          .describe(
            "The cryptocurrency name or symbol (e.g., 'bitcoin', 'eth', 'solana')",
          ),
      },
      async ({ coin }) => {
        try {
          const coinId = resolveCoinId(coin);
          const cacheKey = `market:${coinId}`;

          const data = (await fetchWithCache(
            `${COINGECKO_API}/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`,
            cacheKey,
          )) as CoinGeckoMarketData;

          const md = data.market_data;
          if (!md) {
            throw new Error(`No market data available for ${coin}`);
          }

          const response = {
            coin: {
              id: data.id,
              symbol: data.symbol?.toUpperCase(),
              name: data.name,
              image: data.image?.large,
            },
            price: {
              current: md.current_price?.usd,
              high24h: md.high_24h?.usd,
              low24h: md.low_24h?.usd,
              change24h: md.price_change_24h,
              changePercent24h: md.price_change_percentage_24h,
              changePercent7d: md.price_change_percentage_7d,
              changePercent30d: md.price_change_percentage_30d,
            },
            marketCap: {
              value: md.market_cap?.usd,
              rank: md.market_cap_rank,
              fullyDiluted: md.fully_diluted_valuation?.usd,
              change24h: md.market_cap_change_24h,
              changePercent24h: md.market_cap_change_percentage_24h,
            },
            volume24h: md.total_volume?.usd,
            supply: {
              circulating: md.circulating_supply,
              total: md.total_supply,
              max: md.max_supply,
            },
            allTimeHigh: {
              price: md.ath?.usd,
              changePercent: md.ath_change_percentage?.usd,
              date: md.ath_date?.usd,
            },
            allTimeLow: {
              price: md.atl?.usd,
              changePercent: md.atl_change_percentage?.usd,
              date: md.atl_date?.usd,
            },
            timestamp: new Date().toISOString(),
            source: "CoinGecko",
          };

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(response, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error:
                      error instanceof Error
                        ? error.message
                        : "Failed to fetch market data",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    );

    // Tool 3: List Trending - Get trending cryptocurrencies
    server.tool(
      "list_trending",
      "Get a list of trending cryptocurrencies based on search popularity. " +
        "Useful for discovering popular or viral coins.",
      {},
      async () => {
        try {
          const cacheKey = "trending";

          const data = (await fetchWithCache(
            `${COINGECKO_API}/search/trending`,
            cacheKey,
          )) as CoinGeckoTrendingResponse;

          const trending =
            data.coins?.map((coin, index) => ({
              rank: index + 1,
              id: coin.item.id,
              symbol: coin.item.symbol?.toUpperCase(),
              name: coin.item.name,
              marketCapRank: coin.item.market_cap_rank,
              image: coin.item.small || coin.item.thumb,
              priceUsd: coin.item.data?.price,
              priceChange24h: coin.item.data?.price_change_percentage_24h?.usd,
              marketCap: coin.item.data?.market_cap,
              volume24h: coin.item.data?.total_volume,
            })) || [];

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    trending,
                    count: trending.length,
                    timestamp: new Date().toISOString(),
                    source: "CoinGecko",
                    note: "Ranked by search popularity in the last 24 hours",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error:
                      error instanceof Error
                        ? error.message
                        : "Failed to fetch trending coins",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    );
  },
  {
    capabilities: {
      tools: {},
    },
  },
  {
    redisUrl: process.env.REDIS_URL,
    basePath: "/api/mcps/crypto",
    maxDuration: 300,
  },
);

/**
 * GET /api/mcps/crypto/[transport]
 * POST /api/mcps/crypto/[transport]
 * DELETE /api/mcps/crypto/[transport]
 *
 * MCP transport endpoint for cryptocurrency price data.
 * Handles tool invocations for crypto operations (get price, market data, trending coins).
 * Uses CoinGecko API with caching.
 *
 * @param request - The Next.js request object.
 * @param context - Route context containing the transport parameter.
 * @returns MCP handler response.
 */
export { handler as GET, handler as POST, handler as DELETE };
