import {
  type IAgentRuntime,
  Service,
  logger,
  type TokenData,
  type TransactionResult,
} from '@elizaos/core';

export interface SwapQuote {
  inAmount: string;
  outAmount: string;
  priceImpact: number;
  fee: string;
  rate: number;
  route: any[]; // Simplified route
}

// Based on example_highlevel_services/tests/swap-service.test.ts
export interface ISwapService extends Service {
  swap(params: any): Promise<TransactionResult>;
  getQuote(params: any): Promise<SwapQuote>;
  getSupportedTokens?(): Promise<Partial<TokenData>[]>;
}

export class DummySwapService extends Service implements ISwapService {
  static readonly serviceName = 'SWAP';
  static readonly serviceType = 'swap';
  readonly capabilityDescription = 'Provides a dummy swap service for testing.';

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    logger.info('DummySwapService initialized');
  }

  async getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: number;
  }): Promise<SwapQuote> {
    logger.debug(`[DummySwapService] getQuote called for`, params);
    // Simulate a quote with some dummy data
    const outAmount = params.amount * 0.99; // Simulate 1% fee/slippage
    const rate = 0.99;
    return {
      inAmount: String(params.amount),
      outAmount: String(outAmount),
      priceImpact: 0.001, // 0.1%
      fee: String(params.amount * 0.003), // 0.3% fee
      rate,
      route: [
        {
          dex: 'dummy-dex',
          in: params.inputMint,
          out: params.outputMint,
        },
      ],
    };
  }

  async swap(params: any): Promise<TransactionResult> {
    logger.debug(`[DummySwapService] swap called with`, params);
    return {
      success: true,
      transactionId: `dummy-swap-tx-${Date.now()}`,
    };
  }

  async getSupportedTokens(): Promise<Partial<TokenData>[]> {
    return [
      {
        address: 'So11111111111111111111111111111111111111112',
        symbol: 'SOL',
        name: 'Solana',
      },
      {
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyB7u6a',
        symbol: 'USDC',
        name: 'USD Coin',
      },
    ];
  }

  static async start(runtime: IAgentRuntime): Promise<DummySwapService> {
    const service = new DummySwapService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService<DummySwapService>(DummySwapService.serviceType);
    if (service) {
      await service.stop();
    }
  }

  async start(): Promise<void> {
    logger.info(`[${DummySwapService.serviceName}] Service started.`);
  }

  async stop(): Promise<void> {
    logger.info(`[${DummySwapService.serviceName}] Service stopped.`);
  }
}
