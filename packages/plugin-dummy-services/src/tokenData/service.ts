import { IAgentRuntime, Service, logger } from '@elizaos/core';

// Define token data types locally since they're not in core
export interface TokenData {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  totalSupply: string;
  priceUsd: number;
  marketCapUsd: number;
  volume24hUsd: number;
  priceChange24h: number;
}

/**
 * Dummy token data service for testing purposes
 * Provides mock implementations of token data operations
 */
export class DummyTokenDataService extends Service {
  // Use a custom service type since TOKEN_DATA isn't in ServiceType enum
  static readonly serviceType = 'token_data';

  private serviceName = 'DummyTokenDataService';
  capabilityDescription = 'Dummy token data service for testing';

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

  async searchTokens(query: string): Promise<TokenData[]> {
    return [
      {
        symbol: query.toUpperCase(),
        name: `${query} Token`,
        address: '0xdummy1',
        decimals: 18,
        totalSupply: '1000000000',
        priceUsd: 1.23,
        marketCapUsd: 1230000000,
        volume24hUsd: 45600000,
        priceChange24h: 5.67,
      },
      {
        symbol: `${query.toUpperCase()}2`,
        name: `${query} Token 2`,
        address: '0xdummy2',
        decimals: 18,
        totalSupply: '2000000000',
        priceUsd: 2.46,
        marketCapUsd: 4920000000,
        volume24hUsd: 91200000,
        priceChange24h: -3.21,
      },
    ];
  }

  getDexName(): string {
    return 'dummy-token-data';
  }
}
