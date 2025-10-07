import { IAgentRuntime, Service, logger } from '@elizaos/core';

// Define token data types locally since they're not in core
export interface TokenData {
  id?: string;
  symbol: string;
  name: string;
  address: string;
  chain?: string;
  decimals: number;
  totalSupply: string;
  price?: number;
  priceUsd: number;
  marketCapUsd: number;
  marketCapUSD?: number;
  volume24hUsd: number;
  volume24hUSD?: number;
  priceChange24h: number;
  priceChange24hPercent?: number;
  logoURI?: string;
  liquidity?: number;
  holders?: number;
  sourceProvider?: string;
  lastUpdatedAt?: Date;
  raw?: any;
}

/**
 * Dummy token data service for testing purposes
 * Provides mock implementations of token data operations
 */
export class DummyTokenDataService extends Service {
  // Use a custom service type since TOKEN_DATA isn't in ServiceType enum
  static readonly serviceType = 'token_data';

  capabilityDescription = 'Dummy token data service for testing';

  get serviceName(): string {
    return 'dummy-token-data';
  }

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<DummyTokenDataService> {
    const service = new DummyTokenDataService(runtime);
    await service.start();
    return service;
  }

  async start(): Promise<void> {
    logger.info(`[${this.serviceName}] Service started.`);
  }

  async stop(): Promise<void> {
    logger.info(`[${this.serviceName}] Service stopped.`);
  }

  async getTokenData(tokenAddress: string): Promise<TokenData> {
    return {
      symbol: 'DUMMY',
      name: 'Dummy Token',
      address: tokenAddress,
      decimals: 18,
      totalSupply: '1000000000',
      priceUsd: 1.23,
      marketCapUsd: 1230000000,
      volume24hUsd: 45600000,
      priceChange24h: 5.67,
    };
  }

  async getTokenDataBySymbol(symbol: string): Promise<TokenData> {
    return {
      symbol: symbol.toUpperCase(),
      name: `${symbol} Token`,
      address: '0xdummy',
      decimals: 18,
      totalSupply: '1000000000',
      priceUsd: 1.23,
      marketCapUsd: 1230000000,
      volume24hUsd: 45600000,
      priceChange24h: 5.67,
    };
  }

  async getMultipleTokenData(tokenAddresses: string[]): Promise<TokenData[]> {
    return tokenAddresses.map((address, index) => ({
      symbol: `TOKEN${index}`,
      name: `Token ${index}`,
      address,
      decimals: 18,
      totalSupply: '1000000000',
      priceUsd: 1.23 * (index + 1),
      marketCapUsd: 1230000000 * (index + 1),
      volume24hUsd: 45600000 * (index + 1),
      priceChange24h: 5.67 * (index % 2 === 0 ? 1 : -1),
    }));
  }

  async getTokenDetails(address: string, chain: string = 'solana'): Promise<any | null> {
    // Generate a consistent symbol from address (first 4 chars after prefix)
    const symbol = address.startsWith('So')
      ? address.substring(2, 6)
      : address.substring(0, 4).toUpperCase();

    return {
      id: `${chain}:${address}`,
      symbol,
      name: `Dummy Token ${symbol}`,
      address,
      chain,
      decimals: 18,
      totalSupply: '1000000000',
      price: 1.23 + Math.random() * 10,
      priceUsd: 1.23 + Math.random() * 10,
      marketCapUsd: 1230000000 + Math.random() * 1000000000,
      marketCapUSD: 1230000000 + Math.random() * 1000000000,
      volume24hUsd: 45600000 + Math.random() * 50000000,
      volume24hUSD: 45600000 + Math.random() * 50000000,
      priceChange24h: -10 + Math.random() * 20,
      priceChange24hPercent: -10 + Math.random() * 20,
      logoURI: 'https://via.placeholder.com/150',
      liquidity: 5000000 + Math.random() * 5000000,
      holders: Math.floor(1000 + Math.random() * 9000),
      sourceProvider: 'dummy',
      lastUpdatedAt: new Date(),
      raw: {
        dummyData: true,
      },
    };
  }

  async getTrendingTokens(chain: string = 'solana', limit: number = 10): Promise<TokenData[]> {
    const tokens: TokenData[] = [];
    for (let i = 0; i < limit; i++) {
      const symbol = `TREND${i + 1}`;
      tokens.push({
        id: `${chain}:0xtrending${i}`,
        symbol,
        name: `Trending Token ${i + 1}`,
        address: `0xtrending${i}`,
        chain,
        decimals: 18,
        totalSupply: '1000000000',
        price: Math.random() * 100,
        priceUsd: Math.random() * 100,
        marketCapUsd: 1000000 + Math.random() * 1000000000,
        marketCapUSD: 1000000 + Math.random() * 1000000000,
        volume24hUsd: 100000 + Math.random() * 10000000,
        volume24hUSD: 100000 + Math.random() * 10000000,
        priceChange24h: -50 + Math.random() * 100,
        priceChange24hPercent: -10 + Math.random() * 20,
        logoURI: 'https://via.placeholder.com/150',
        liquidity: 1000000 + Math.random() * 9000000,
        holders: Math.floor(500 + Math.random() * 9500),
        sourceProvider: 'dummy',
        lastUpdatedAt: new Date(),
        raw: {
          dummyData: true,
        },
      });
    }
    return tokens;
  }

  async searchTokens(
    query: string,
    chain: string = 'solana',
    limit: number = 5
  ): Promise<TokenData[]> {
    const upperQuery = query.toUpperCase();
    const tokens: TokenData[] = [];

    // Return the requested number of tokens
    for (let i = 0; i < limit; i++) {
      const symbol = upperQuery; // All tokens should have the same symbol for search
      tokens.push({
        id: `${chain}:0xsearch${i}`,
        symbol,
        name: `Dummy Token ${upperQuery}`,
        address: `0xsearch${i}`,
        chain,
        decimals: 18,
        totalSupply: '1000000000',
        price: 1.23 * (i + 1),
        priceUsd: 1.23 * (i + 1),
        marketCapUsd: 1230000000 * (i + 1),
        marketCapUSD: 1230000000 * (i + 1),
        volume24hUsd: 45600000 * (i + 1),
        volume24hUSD: 45600000 * (i + 1),
        priceChange24h: 5.67 * (i % 2 === 0 ? 1 : -1),
        priceChange24hPercent: 5.67 * (i % 2 === 0 ? 1 : -1),
        logoURI: 'https://via.placeholder.com/150',
        liquidity: 1000000 + Math.random() * 9000000,
        holders: Math.floor(500 + Math.random() * 9500),
        sourceProvider: 'dummy',
        lastUpdatedAt: new Date(),
        raw: {
          dummyData: true,
        },
      });
    }
    return tokens;
  }

  async getTokensByAddresses(addresses: string[], chain: string = 'solana'): Promise<TokenData[]> {
    return addresses.map((address, index) => {
      // Generate symbol from address
      const symbol =
        address.length > 6 ? address.substring(2, 6).toUpperCase() : address.toUpperCase();
      return {
        id: `${chain}:${address}`,
        symbol,
        name: `Dummy Token ${symbol}`,
        address,
        chain,
        decimals: 18,
        totalSupply: '1000000000',
        price: 1.23 * (index + 1),
        priceUsd: 1.23 * (index + 1),
        marketCapUsd: 1230000000 * (index + 1),
        marketCapUSD: 1230000000 * (index + 1),
        volume24hUsd: 45600000 * (index + 1),
        volume24hUSD: 45600000 * (index + 1),
        priceChange24h: 5.67 * (index % 2 === 0 ? 1 : -1),
        priceChange24hPercent: 5.67 * (index % 2 === 0 ? 1 : -1),
        logoURI: 'https://via.placeholder.com/150',
        liquidity: 1000000 + Math.random() * 9000000,
        holders: Math.floor(500 + Math.random() * 9500),
        sourceProvider: 'dummy',
        lastUpdatedAt: new Date(),
        raw: {
          dummyData: true,
        },
      };
    });
  }

  getDexName(): string {
    return 'dummy-token-data';
  }
}
