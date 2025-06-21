import {
  type IAgentRuntime,
  Service,
  logger,
  type TokenData,
  type TransactionResult,
  asUUID,
} from '@elizaos/core';
import { v4 as uuid } from 'uuid';

export interface TokenCreationResult extends TransactionResult {
  tokenAddress: string;
  tokenData: Partial<TokenData>;
}

// Based on example_highlevel_services/tests/token-creation-service.test.ts
export interface ITokenCreationService extends Service {
  createToken(params: any): Promise<TokenCreationResult>;
  getTokenInfo(address: string): Promise<Partial<TokenData> | null>;
  isReady(): Promise<boolean>;
  getDeployerAddress(): Promise<string | null>;
}

export class DummyTokenCreationService extends Service implements ITokenCreationService {
  static readonly serviceName = 'TOKEN_CREATION';
  static readonly serviceType = 'token-creation';
  readonly capabilityDescription = 'Provides a dummy token creation service for testing.';

  private tokens: Map<string, Partial<TokenData>> = new Map();
  private deployerAddress = 'DummyDeployerAddress_xxxxxxxxxxxx';

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    logger.info('DummyTokenCreationService initialized');
  }

  async createToken(params: {
    name: string;
    symbol: string;
    description: string;
    imageUrl: string;
  }): Promise<TokenCreationResult> {
    const tokenAddress = `dummy-token-${uuid()}`;
    const tokenData: Partial<TokenData> = {
      address: tokenAddress,
      name: params.name,
      symbol: params.symbol,
      logoURI: params.imageUrl,
      raw: {
        description: params.description,
      },
    };
    this.tokens.set(tokenAddress, tokenData);

    logger.debug(`[DummyTokenCreationService] Created token ${params.symbol}: ${tokenAddress}`);

    return {
      success: true,
      transactionId: `dummy-creation-tx-${Date.now()}`,
      tokenAddress,
      tokenData,
    };
  }

  async getTokenInfo(address: string): Promise<Partial<TokenData> | null> {
    return this.tokens.get(address) || null;
  }

  async isReady(): Promise<boolean> {
    return true; // Always ready
  }

  async getDeployerAddress(): Promise<string | null> {
    return this.deployerAddress;
  }

  static async start(runtime: IAgentRuntime): Promise<DummyTokenCreationService> {
    const service = new DummyTokenCreationService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService<DummyTokenCreationService>(
      DummyTokenCreationService.serviceType
    );
    if (service) {
      await service.stop();
    }
  }

  async start(): Promise<void> {
    logger.info(`[${DummyTokenCreationService.serviceName}] Service started.`);
  }

  async stop(): Promise<void> {
    logger.info(`[${DummyTokenCreationService.serviceName}] Service stopped.`);
  }
}
