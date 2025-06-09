import { Service, ServiceType } from './service';

/**
 * A standardized representation of a token holding.
 */
export interface TokenBalance {
  address: string; // Token mint address, or a native identifier like 'SOL' or 'ETH'
  balance: string; // Raw balance as a string to handle large numbers with precision
  decimals: number;
  uiAmount?: number; // User-friendly balance, adjusted for decimals
  name?: string;
  symbol?: string;
  logoURI?: string;
}

/**
 * Generic representation of token data that can be provided by various services.
 */
export interface TokenData {
  id: string; // Unique identifier (e.g., contract address or a composite ID)
  symbol: string;
  name: string;
  address: string; // Contract address
  chain: string; // e.g., 'solana', 'ethereum', 'base'
  sourceProvider: string; // e.g., 'birdeye', 'coinmarketcap'

  price?: number;
  priceChange24hPercent?: number;
  priceChange24hUSD?: number; // Absolute change

  volume24hUSD?: number;
  marketCapUSD?: number;

  liquidity?: number;
  holders?: number;

  logoURI?: string;
  decimals?: number;

  // Timestamps
  lastUpdatedAt?: Date; // When this specific data point was last updated from the source

  // Optional raw data from the provider
  raw?: any;
}

/**
 * Interface for a generic service that provides token data.
 */
export abstract class ITokenDataService extends Service {
  static override readonly serviceType = ServiceType.TOKEN_DATA;
  public readonly capabilityDescription =
    'Provides standardized access to token market data.' as string;

  /**
   * Fetches detailed information for a single token.
   * @param address The token's contract address.
   * @param chain The blockchain the token resides on.
   * @returns A Promise resolving to TokenData or null if not found.
   */
  abstract getTokenDetails(address: string, chain: string): Promise<TokenData | null>;

  /**
   * Fetches a list of trending tokens.
   * @param chain Optional: Filter by a specific blockchain.
   * @param limit Optional: Number of tokens to return. Defaults to a service-specific value.
   * @param timePeriod Optional: Time period for trending data (e.g., '24h', '7d'). Defaults to service-specific.
   * @returns A Promise resolving to an array of TokenData.
   */
  abstract getTrendingTokens(
    chain?: string,
    limit?: number,
    timePeriod?: string
  ): Promise<TokenData[]>;

  /**
   * Searches for tokens based on a query string.
   * @param query The search query (e.g., symbol, name, address).
   * @param chain Optional: Filter by a specific blockchain.
   * @param limit Optional: Number of results to return.
   * @returns A Promise resolving to an array of TokenData.
   */
  abstract searchTokens(query: string, chain?: string, limit?: number): Promise<TokenData[]>;

  /**
   * Fetches data for multiple tokens by their addresses on a specific chain.
   * @param addresses Array of token contract addresses.
   * @param chain The blockchain the tokens reside on.
   * @returns A Promise resolving to an array of TokenData. May not include all requested if some are not found.
   */
  abstract getTokensByAddresses(addresses: string[], chain: string): Promise<TokenData[]>;

  // Future potential methods:
  // getHistoricalPriceData(address: string, chain: string, timeFrame: string): Promise<any[]>;
  // getTokenMarketChart(address: string, chain: string, days: number): Promise<any[]>;
}
