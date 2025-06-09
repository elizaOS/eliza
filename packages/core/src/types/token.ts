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
export interface ITokenDataService {
  /**
   * A unique identifier for the service, matching how it's registered.
   */
  readonly serviceName: string;

  /**
   * Fetches detailed information for a single token.
   * @param address The token's contract address.
   * @param chain The blockchain the token resides on.
   * @returns A Promise resolving to TokenData or null if not found.
   */
  getTokenDetails(address: string, chain: string): Promise<TokenData | null>;

  /**
   * Fetches a list of trending tokens.
   * @param chain Optional: Filter by a specific blockchain.
   * @param limit Optional: Number of tokens to return. Defaults to a service-specific value.
   * @param timePeriod Optional: Time period for trending data (e.g., '24h', '7d'). Defaults to service-specific.
   * @returns A Promise resolving to an array of TokenData.
   */
  getTrendingTokens(chain?: string, limit?: number, timePeriod?: string): Promise<TokenData[]>;

  /**
   * Searches for tokens based on a query string.
   * @param query The search query (e.g., symbol, name, address).
   * @param chain Optional: Filter by a specific blockchain.
   * @param limit Optional: Number of results to return.
   * @returns A Promise resolving to an array of TokenData.
   */
  searchTokens(query: string, chain?: string, limit?: number): Promise<TokenData[]>;

  /**
   * Fetches data for multiple tokens by their addresses on a specific chain.
   * @param addresses Array of token contract addresses.
   * @param chain The blockchain the tokens reside on.
   * @returns A Promise resolving to an array of TokenData. May not include all requested if some are not found.
   */
  getTokensByAddresses(addresses: string[], chain: string): Promise<TokenData[]>;

  // Future potential methods:
  // getHistoricalPriceData(address: string, chain: string, timeFrame: string): Promise<any[]>;
  // getTokenMarketChart(address: string, chain: string, days: number): Promise<any[]>;
}

/**
 * Constant for the TokenDataService name.
 * Ideally, this would be part of a shared enum in @elizaos/core.
 */
export const TOKEN_DATA_SERVICE_NAME = 'TokenDataService';
