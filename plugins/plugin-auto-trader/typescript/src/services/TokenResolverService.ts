/**
 * Token Resolver Service
 *
 * Dynamically resolves token symbols to addresses using Birdeye API.
 * Supports any Solana token, not just hardcoded ones.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  price?: number;
  volume24h?: number;
  liquidity?: number;
  logoURI?: string;
}

/** Well-known tokens that don't need API lookup */
const WELL_KNOWN_TOKENS: Record<string, TokenInfo> = {
  SOL: {
    address: "So11111111111111111111111111111111111111112",
    symbol: "SOL",
    name: "Solana",
    decimals: 9,
  },
  USDC: {
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
  },
  USDT: {
    address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
  },
};

/** Solana address regex - base58, 32-44 chars */
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class TokenResolverService extends Service {
  public static readonly serviceType = "TokenResolverService";
  public readonly capabilityDescription = "Resolves token symbols to addresses dynamically";

  private cache = new Map<string, TokenInfo>();
  private cacheExpiry = new Map<string, number>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    // Pre-populate cache with well-known tokens
    for (const [symbol, info] of Object.entries(WELL_KNOWN_TOKENS)) {
      this.cache.set(symbol.toUpperCase(), info);
      this.cache.set(info.address, info);
    }
  }

  public static async start(runtime: IAgentRuntime): Promise<TokenResolverService> {
    const instance = new TokenResolverService(runtime);
    logger.info("[TokenResolverService] Started");
    return instance;
  }

  public async stop(): Promise<void> {
    this.cache.clear();
    this.cacheExpiry.clear();
  }

  /**
   * Check if a string is a valid Solana address
   */
  public isValidAddress(input: string): boolean {
    return SOLANA_ADDRESS_REGEX.test(input);
  }

  /**
   * Resolve a token symbol or address to full token info
   * Supports: symbol (e.g., "BONK"), address, or partial name
   */
  public async resolve(input: string): Promise<TokenInfo | null> {
    const normalized = input.trim().toUpperCase();

    // Check if it's already an address
    if (this.isValidAddress(input)) {
      return this.resolveByAddress(input);
    }

    // Check cache first
    const cached = this.cache.get(normalized);
    if (cached && this.isCacheValid(normalized)) {
      return cached;
    }

    // Search via Birdeye API
    return this.searchToken(input);
  }

  /**
   * Resolve multiple tokens at once
   */
  public async resolveMany(inputs: string[]): Promise<Map<string, TokenInfo | null>> {
    const results = new Map<string, TokenInfo | null>();

    await Promise.all(
      inputs.map(async (input) => {
        results.set(input, await this.resolve(input));
      }),
    );

    return results;
  }

  /**
   * Get token info by address
   */
  public async resolveByAddress(address: string): Promise<TokenInfo | null> {
    // Check cache
    const cached = this.cache.get(address);
    if (cached && this.isCacheValid(address)) {
      return cached;
    }

    const apiKey = this.runtime.getSetting("BIRDEYE_API_KEY");
    if (!apiKey) {
      logger.warn("[TokenResolverService] No Birdeye API key configured");
      return null;
    }

    const response = await fetch(
      `https://public-api.birdeye.so/defi/token_overview?address=${address}`,
      {
        headers: {
          "X-API-KEY": String(apiKey),
          "x-chain": "solana",
        },
      },
    );

    if (!response.ok) {
      logger.warn(
        `[TokenResolverService] Failed to resolve address ${address}: ${response.status}`,
      );
      return null;
    }

    const data = (await response.json()) as {
      success: boolean;
      data: {
        address: string;
        symbol: string;
        name: string;
        decimals: number;
        price: number;
        v24hUSD: number;
        liquidity: number;
        logoURI?: string;
      };
    };

    if (!data.success || !data.data) {
      return null;
    }

    const tokenInfo: TokenInfo = {
      address: data.data.address,
      symbol: data.data.symbol,
      name: data.data.name,
      decimals: data.data.decimals,
      price: data.data.price,
      volume24h: data.data.v24hUSD,
      liquidity: data.data.liquidity,
      logoURI: data.data.logoURI,
    };

    this.setCache(address, tokenInfo);
    this.setCache(tokenInfo.symbol.toUpperCase(), tokenInfo);

    return tokenInfo;
  }

  /**
   * Search for a token by symbol or name
   */
  public async searchToken(query: string): Promise<TokenInfo | null> {
    const apiKey = this.runtime.getSetting("BIRDEYE_API_KEY");
    if (!apiKey) {
      logger.warn("[TokenResolverService] No Birdeye API key configured");
      return null;
    }

    const response = await fetch(
      `https://public-api.birdeye.so/defi/v3/search?chain=solana&keyword=${encodeURIComponent(query)}&target=token&sort_by=volume_24h_usd&sort_type=desc&limit=5`,
      {
        headers: {
          "X-API-KEY": String(apiKey),
          "x-chain": "solana",
        },
      },
    );

    if (!response.ok) {
      logger.warn(`[TokenResolverService] Search failed for "${query}": ${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      success: boolean;
      data: {
        items: Array<{
          address: string;
          symbol: string;
          name: string;
          decimals: number;
          price: number;
          volume_24h_usd: number;
          liquidity: number;
          logo_uri?: string;
        }>;
      };
    };

    if (!data.success || !data.data?.items?.length) {
      logger.info(`[TokenResolverService] No results for "${query}"`);
      return null;
    }

    // Find best match - exact symbol match preferred
    const exactMatch = data.data.items.find((t) => t.symbol.toUpperCase() === query.toUpperCase());
    const token = exactMatch || data.data.items[0];

    const tokenInfo: TokenInfo = {
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      price: token.price,
      volume24h: token.volume_24h_usd,
      liquidity: token.liquidity,
      logoURI: token.logo_uri,
    };

    this.setCache(tokenInfo.address, tokenInfo);
    this.setCache(tokenInfo.symbol.toUpperCase(), tokenInfo);

    logger.info(
      `[TokenResolverService] Resolved "${query}" → ${tokenInfo.symbol} (${tokenInfo.address.slice(0, 8)}...)`,
    );
    return tokenInfo;
  }

  /**
   * Get trending tokens from Birdeye
   */
  public async getTrendingTokens(limit = 20): Promise<TokenInfo[]> {
    const apiKey = this.runtime.getSetting("BIRDEYE_API_KEY");
    if (!apiKey) {
      return [];
    }

    const response = await fetch(
      `https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=${limit}`,
      {
        headers: {
          "X-API-KEY": String(apiKey),
          "x-chain": "solana",
        },
      },
    );

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as {
      success: boolean;
      data: {
        tokens: Array<{
          address: string;
          symbol: string;
          name: string;
          decimals: number;
          price: number;
          v24hUSD: number;
          liquidity: number;
          logoURI?: string;
        }>;
      };
    };

    if (!data.success || !data.data?.tokens) {
      return [];
    }

    return data.data.tokens.map((t) => ({
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      price: t.price,
      volume24h: t.v24hUSD,
      liquidity: t.liquidity,
      logoURI: t.logoURI,
    }));
  }

  private setCache(key: string, info: TokenInfo): void {
    this.cache.set(key, info);
    this.cacheExpiry.set(key, Date.now() + this.CACHE_TTL);
  }

  private isCacheValid(key: string): boolean {
    const expiry = this.cacheExpiry.get(key);
    return expiry ? Date.now() < expiry : false;
  }
}
