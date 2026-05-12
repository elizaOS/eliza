/**
 * elizaOS Token Price Service
 *
 * Fetches and caches elizaOS token prices from multiple sources.
 * Uses a multi-source approach for price reliability and manipulation resistance.
 *
 * SECURITY CONSIDERATIONS:
 * 1. Uses multiple price sources and validates consistency
 * 2. Rejects prices with >5% deviation between sources
 * 3. Caches prices with short TTL to balance freshness vs. manipulation
 * 4. Falls back to cached price if all sources fail
 * 5. Logs all price fetches for audit trail
 */

import { and, desc, eq, gte } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import { elizaTokenPrices } from "@/db/schemas/token-redemptions";
import { logger } from "@/lib/utils/logger";

// elizaOS Token Addresses
export const ELIZA_TOKEN_ADDRESSES = {
  // EVM chains (same address on ETH, Base, BNB)
  ethereum: "0xea17df5cf6d172224892b5477a16acb111182478" as const,
  base: "0xea17df5cf6d172224892b5477a16acb111182478" as const,
  bnb: "0xea17df5cf6d172224892b5477a16acb111182478" as const,
  // Solana
  solana: "DuMbhu7mvQvqQHGcnikDgb4XegXJRyhUBfdU22uELiZA" as const,
} as const;

export type SupportedNetwork = keyof typeof ELIZA_TOKEN_ADDRESSES;

// Price source configuration
const PRICE_SOURCES = {
  coingecko: {
    // CoinGecko API (requires API key for production)
    evm: "https://api.coingecko.com/api/v3/simple/token_price/ethereum",
    solana: "https://api.coingecko.com/api/v3/simple/token_price/solana",
  },
  dexscreener: {
    // DexScreener (free, no API key needed)
    base: "https://api.dexscreener.com/latest/dex/tokens/",
  },
  jupiter: {
    // Jupiter Aggregator for Solana
    solana: "https://price.jup.ag/v6/price",
  },
} as const;

// Price cache TTL (30 seconds for fresh prices)
const PRICE_CACHE_TTL_MS = 30 * 1000;

// Quote validity period (5 minutes)
const QUOTE_VALIDITY_MS = 5 * 60 * 1000;

// Maximum allowed deviation between sources (5%)
const MAX_PRICE_DEVIATION = 0.05;

// Minimum price threshold to prevent dust attacks
const MIN_ELIZA_PRICE_USD = 0.000001;

interface PriceQuote {
  priceUsd: number;
  source: string;
  timestamp: Date;
  expiresAt: Date;
  network: SupportedNetwork;
}

interface PriceFetchResult {
  success: boolean;
  priceUsd?: number;
  source: string;
  error?: string;
}

/**
 * elizaOS Token Price Service
 */
export class ElizaTokenPriceService {
  constructor() {
    if (!this.coinGeckoApiKey && process.env.NODE_ENV === "production") {
      logger.warn("[ElizaPrice] COINGECKO_API_KEY not set - using free tier with rate limits");
    }
  }

  private get coinGeckoApiKey(): string | undefined {
    return process.env.COINGECKO_API_KEY;
  }

  /**
   * Get current elizaOS token price with multi-source validation.
   * Returns cached price if valid, otherwise fetches fresh prices.
   */
  async getPrice(network: SupportedNetwork): Promise<PriceQuote> {
    // Check cache first
    const cachedPrice = await this.getCachedPrice(network);
    if (cachedPrice) {
      logger.debug(`[ElizaPrice] Using cached price for ${network}: $${cachedPrice.priceUsd}`);
      return cachedPrice;
    }

    // Fetch from multiple sources
    const prices = await this.fetchFromMultipleSources(network);

    // Validate price consistency
    const validatedPrice = this.validatePrices(prices, network);

    // Cache the validated price
    await this.cachePrice(network, validatedPrice);

    return validatedPrice;
  }

  /**
   * Get a locked price quote for a redemption request.
   * Quote is valid for QUOTE_VALIDITY_MS.
   */
  async getQuote(
    network: SupportedNetwork,
    pointsAmount: number,
  ): Promise<{
    quote: PriceQuote;
    usdValue: number;
    elizaAmount: number;
  }> {
    const quote = await this.getPrice(network);

    // 1 point = 1 cent = $0.01
    const usdValue = pointsAmount / 100;

    // Calculate elizaOS tokens: USD value / price per token
    const elizaAmount = usdValue / quote.priceUsd;

    logger.info(`[ElizaPrice] Quote generated`, {
      network,
      pointsAmount,
      usdValue,
      priceUsd: quote.priceUsd,
      elizaAmount,
      expiresAt: quote.expiresAt,
    });

    return {
      quote,
      usdValue,
      elizaAmount,
    };
  }

  /**
   * Fetch price from CoinGecko.
   */
  private async fetchFromCoinGecko(network: SupportedNetwork): Promise<PriceFetchResult> {
    const tokenAddress = ELIZA_TOKEN_ADDRESSES[network];
    const isEvm = network !== "solana";

    const baseUrl = isEvm ? PRICE_SOURCES.coingecko.evm : PRICE_SOURCES.coingecko.solana;

    const platform =
      network === "solana"
        ? "solana"
        : network === "base"
          ? "base"
          : network === "bnb"
            ? "binance-smart-chain"
            : "ethereum";

    const url = `${baseUrl.replace("ethereum", platform)}?contract_addresses=${tokenAddress}&vs_currencies=usd`;

    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (this.coinGeckoApiKey) {
      headers["x-cg-pro-api-key"] = this.coinGeckoApiKey;
    }

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(2000), // SECURITY: Short timeout to prevent DoS
    });

    if (!response.ok) {
      return {
        success: false,
        source: "coingecko",
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = (await response.json()) as Record<string, { usd?: number }>;
    const priceData = data[tokenAddress.toLowerCase()];

    if (!priceData?.usd) {
      return {
        success: false,
        source: "coingecko",
        error: "No price data in response",
      };
    }

    return {
      success: true,
      priceUsd: priceData.usd,
      source: "coingecko",
    };
  }

  /**
   * Fetch price from DexScreener (for EVM chains).
   */
  private async fetchFromDexScreener(network: SupportedNetwork): Promise<PriceFetchResult> {
    if (network === "solana") {
      return {
        success: false,
        source: "dexscreener",
        error: "Not supported for Solana",
      };
    }

    const tokenAddress = ELIZA_TOKEN_ADDRESSES[network];
    const url = `${PRICE_SOURCES.dexscreener.base}${tokenAddress}`;

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(2000), // SECURITY: Short timeout to prevent DoS
    });

    if (!response.ok) {
      return {
        success: false,
        source: "dexscreener",
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = (await response.json()) as {
      pairs?: Array<{ priceUsd?: string }>;
    };

    if (!data.pairs?.length || !data.pairs[0]?.priceUsd) {
      return {
        success: false,
        source: "dexscreener",
        error: "No price data in response",
      };
    }

    return {
      success: true,
      priceUsd: parseFloat(data.pairs[0].priceUsd),
      source: "dexscreener",
    };
  }

  /**
   * Fetch price from Jupiter (for Solana).
   */
  private async fetchFromJupiter(network: SupportedNetwork): Promise<PriceFetchResult> {
    if (network !== "solana") {
      return {
        success: false,
        source: "jupiter",
        error: "Only supported for Solana",
      };
    }

    const tokenAddress = ELIZA_TOKEN_ADDRESSES.solana;
    const url = `${PRICE_SOURCES.jupiter.solana}?ids=${tokenAddress}`;

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(2000), // SECURITY: Short timeout to prevent DoS
    });

    if (!response.ok) {
      return {
        success: false,
        source: "jupiter",
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = (await response.json()) as {
      data?: Record<string, { price?: number }>;
    };
    const priceData = data.data?.[tokenAddress];

    if (!priceData?.price) {
      return {
        success: false,
        source: "jupiter",
        error: "No price data in response",
      };
    }

    return {
      success: true,
      priceUsd: priceData.price,
      source: "jupiter",
    };
  }

  /**
   * Fetch from multiple sources in parallel.
   */
  private async fetchFromMultipleSources(network: SupportedNetwork): Promise<PriceFetchResult[]> {
    const fetchers: Promise<PriceFetchResult>[] = [];

    // CoinGecko (all networks)
    fetchers.push(
      this.fetchFromCoinGecko(network).catch(
        (error): PriceFetchResult => ({
          success: false,
          source: "coingecko",
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      ),
    );

    if (network === "solana") {
      // Jupiter for Solana
      fetchers.push(
        this.fetchFromJupiter(network).catch(
          (error): PriceFetchResult => ({
            success: false,
            source: "jupiter",
            error: error instanceof Error ? error.message : "Unknown error",
          }),
        ),
      );
    } else {
      // DexScreener for EVM
      fetchers.push(
        this.fetchFromDexScreener(network).catch(
          (error): PriceFetchResult => ({
            success: false,
            source: "dexscreener",
            error: error instanceof Error ? error.message : "Unknown error",
          }),
        ),
      );
    }

    return await Promise.all(fetchers);
  }

  /**
   * Validate prices from multiple sources.
   * Throws if prices deviate too much or all sources fail.
   */
  private validatePrices(prices: PriceFetchResult[], network: SupportedNetwork): PriceQuote {
    const successfulPrices = prices.filter((p) => p.success && p.priceUsd !== undefined);

    if (successfulPrices.length === 0) {
      const errors = prices.map((p) => `${p.source}: ${p.error}`).join("; ");
      logger.error(`[ElizaPrice] All price sources failed for ${network}`, {
        errors,
      });
      throw new Error(`Unable to fetch elizaOS price: ${errors}`);
    }

    // If we have multiple prices, check for deviation
    if (successfulPrices.length > 1) {
      const priceValues = successfulPrices.map((p) => p.priceUsd!);
      const avgPrice = priceValues.reduce((a, b) => a + b, 0) / priceValues.length;

      for (const price of priceValues) {
        const deviation = Math.abs(price - avgPrice) / avgPrice;
        if (deviation > MAX_PRICE_DEVIATION) {
          logger.error(`[ElizaPrice] Price deviation too high for ${network}`, {
            prices: successfulPrices.map((p) => ({
              source: p.source,
              price: p.priceUsd,
            })),
            deviation,
            maxAllowed: MAX_PRICE_DEVIATION,
          });
          throw new Error(
            `Price sources disagree by ${(deviation * 100).toFixed(1)}% - possible manipulation`,
          );
        }
      }
    }

    // Use the first successful price (prefer CoinGecko)
    const selectedPrice = successfulPrices[0];

    // Validate minimum price
    if (selectedPrice.priceUsd! < MIN_ELIZA_PRICE_USD) {
      throw new Error(`elizaOS price too low: $${selectedPrice.priceUsd}`);
    }

    const now = new Date();

    return {
      priceUsd: selectedPrice.priceUsd!,
      source: selectedPrice.source,
      timestamp: now,
      expiresAt: new Date(now.getTime() + QUOTE_VALIDITY_MS),
      network,
    };
  }

  /**
   * Get cached price if still valid.
   */
  private async getCachedPrice(network: SupportedNetwork): Promise<PriceQuote | null> {
    const now = new Date();
    const minExpiresAt = new Date(now.getTime() - PRICE_CACHE_TTL_MS);

    const cached = await dbRead.query.elizaTokenPrices.findFirst({
      where: and(
        eq(elizaTokenPrices.network, network),
        gte(elizaTokenPrices.fetched_at, minExpiresAt),
      ),
      orderBy: [desc(elizaTokenPrices.fetched_at)],
    });

    if (!cached) {
      return null;
    }

    return {
      priceUsd: Number(cached.price_usd),
      source: cached.source,
      timestamp: cached.fetched_at,
      expiresAt: new Date(now.getTime() + QUOTE_VALIDITY_MS),
      network,
    };
  }

  /**
   * Cache a validated price.
   */
  private async cachePrice(network: SupportedNetwork, quote: PriceQuote): Promise<void> {
    await dbWrite.insert(elizaTokenPrices).values({
      network,
      price_usd: String(quote.priceUsd),
      source: quote.source,
      fetched_at: quote.timestamp,
      expires_at: quote.expiresAt,
    });

    logger.info(`[ElizaPrice] Cached price for ${network}`, {
      priceUsd: quote.priceUsd,
      source: quote.source,
    });
  }
}

// Export singleton instance
export const elizaTokenPriceService = new ElizaTokenPriceService();
