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

/** Multi-chain token info for registry API (getTokenInfo, getTokenAddress, etc.) */
export interface TokenInfoWithAddresses {
  symbol: string;
  name: string;
  decimals: number;
  addresses: Record<string, string>;
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

/** Multi-chain registry for sync API - used by getTokenInfo, getTokenAddress, etc. */
const DEFAULT_REGISTRY: TokenInfoWithAddresses[] = [
  {
    symbol: "SOL",
    name: "Solana",
    decimals: 9,
    addresses: { solana: "So11111111111111111111111111111111111111112" },
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    addresses: {
      solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyB7uH3",
      ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      polygon: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    },
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    addresses: {
      solana: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      ethereum: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      polygon: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    },
  },
  {
    symbol: "ETH",
    name: "Ethereum",
    decimals: 18,
    addresses: { ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  },
  {
    symbol: "MATIC",
    name: "Polygon",
    decimals: 18,
    addresses: {
      polygon: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
      ethereum: "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0", // WMATIC on Ethereum
    },
  },
];

/** Solana address regex - base58, 32-44 chars */
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class TokenResolverService extends Service {
  public static readonly serviceType = "TokenResolverService";
  public readonly capabilityDescription = "Resolves token symbols to addresses dynamically";

  private cache = new Map<string, TokenInfo>();
  private cacheExpiry = new Map<string, number>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  /** Multi-chain registry for sync API (getTokenInfo, getTokenAddress, etc.) */
  private registry = new Map<string, TokenInfoWithAddresses>();

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    // Pre-populate cache with well-known tokens
    for (const [symbol, info] of Object.entries(WELL_KNOWN_TOKENS)) {
      this.cache.set(symbol.toUpperCase(), info);
      this.cache.set(info.address, info);
    }
    // Pre-populate multi-chain registry
    for (const token of DEFAULT_REGISTRY) {
      this.registry.set(token.symbol.toUpperCase(), { ...token });
    }
  }

  public async start(): Promise<void> {
    // Instance start no-op; use static TokenResolverService.start(runtime) to get instance
  }

  public static async start(runtime: IAgentRuntime): Promise<TokenResolverService> {
    const instance = new TokenResolverService(runtime);
    logger.info("[TokenResolverService] Started");
    return instance;
  }

  public async stop(): Promise<void> {
    this.cache.clear();
    this.cacheExpiry.clear();
    this.registry.clear();
  }

  /** Sync: get token info by symbol (multi-chain addresses). */
  public getTokenInfo(symbol: string): TokenInfoWithAddresses | null {
    const key = symbol.trim().toUpperCase();
    return this.registry.get(key) ?? null;
  }

  /** Sync: get token address for a given chain. */
  public getTokenAddress(symbol: string, chain: string): string | null {
    const info = this.getTokenInfo(symbol);
    if (!info?.addresses) return null;
    const chainKey = Object.keys(info.addresses).find(
      (c) => c.toLowerCase() === chain.trim().toLowerCase()
    );
    return chainKey ? info.addresses[chainKey] ?? null : null;
  }

  /** Sync: get all tokens that have an address on the given chain. */
  public getTokensForChain(chain: string): TokenInfoWithAddresses[] {
    const chainLower = chain.trim().toLowerCase();
    return Array.from(this.registry.values()).filter((t) =>
      Object.keys(t.addresses).some((c) => c.toLowerCase() === chainLower)
    );
  }

  /** Sync: register or update a token in the registry. */
  public registerToken(token: TokenInfoWithAddresses): void {
    const key = token.symbol.trim().toUpperCase();
    this.registry.set(key, { ...token, symbol: token.symbol });
  }

  /** Sync: whether a token is available on the given chain. */
  public isTokenAvailable(symbol: string, chain: string): boolean {
    return this.getTokenAddress(symbol, chain) !== null;
  }

  /** Sync: get decimals for a token, or null if unknown. */
  public getTokenDecimals(symbol: string): number | null {
    const info = this.getTokenInfo(symbol);
    return info?.decimals ?? null;
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
