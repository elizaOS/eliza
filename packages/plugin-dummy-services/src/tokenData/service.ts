import {
  ITokenDataService,
  TokenData,
  Service,
  IAgentRuntime,
  ServiceType,
  logger,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

export class DummyTokenDataService extends Service implements ITokenDataService {
  readonly serviceName = 'dummy-token-data';
  static readonly serviceType = ServiceType.TOKEN_DATA;
  readonly capabilityDescription =
    'Provides dummy token data for testing and development purposes.';

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    logger.info('DummyTokenDataService initialized');
  }

  private generateDummyToken(chain: string, address?: string, query?: string): TokenData {
    const randomAddress = address || `0x${uuidv4().replace(/-/g, '')}`;
    const symbol = query ? query.toUpperCase() : randomAddress.substring(2, 6).toUpperCase();
    return {
      id: `${chain}:${randomAddress}`,
      symbol: symbol,
      name: `Dummy Token ${symbol}`,
      address: randomAddress,
      chain: chain,
      sourceProvider: 'dummy',
      price: Math.random() * 100,
      priceChange24hPercent: (Math.random() - 0.5) * 20,
      volume24hUSD: Math.random() * 1000000,
      marketCapUSD: Math.random() * 100000000,
      liquidity: Math.random() * 500000,
      holders: Math.floor(Math.random() * 10000),
      logoURI: 'https://via.placeholder.com/150',
      decimals: 18,
      lastUpdatedAt: new Date(),
      raw: {
        dummyData: true,
      },
    };
  }

  async getTokenDetails(address: string, chain: string): Promise<TokenData | null> {
    logger.debug(`DummyTokenDataService: getTokenDetails for ${address} on ${chain}`);
    return this.generateDummyToken(chain, address);
  }

  async getTrendingTokens(chain = 'solana', limit = 10, _timePeriod = '24h'): Promise<TokenData[]> {
    logger.debug(`DummyTokenDataService: getTrendingTokens on ${chain}`);
    return Array.from({ length: limit }, () => this.generateDummyToken(chain));
  }

  async searchTokens(query: string, chain = 'solana', limit = 5): Promise<TokenData[]> {
    logger.debug(`DummyTokenDataService: searchTokens for "${query}" on ${chain}`);
    return Array.from({ length: limit }, () => this.generateDummyToken(chain, undefined, query));
  }

  async getTokensByAddresses(addresses: string[], chain: string): Promise<TokenData[]> {
    logger.debug(`DummyTokenDataService: getTokensByAddresses on ${chain} for`, addresses);
    return addresses.map((addr) => this.generateDummyToken(chain, addr));
  }

  static async start(runtime: IAgentRuntime): Promise<DummyTokenDataService> {
    const service = new DummyTokenDataService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService<DummyTokenDataService>(DummyTokenDataService.serviceType);
    if (service) {
      await service.stop();
    }
  }

  async start(): Promise<void> {
    logger.info(`[${this.serviceName}] Service started.`);
  }

  async stop(): Promise<void> {
    logger.info(`[${this.serviceName}] Service stopped.`);
  }
}
