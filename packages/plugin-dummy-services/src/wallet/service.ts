import { IAgentRuntime, Service } from '@elizaos/core';

// Define wallet-specific types locally since they're not in core
export interface WalletPortfolio {
  totalValueUsd: number;
  assets: Array<{
    symbol: string;
    balance: number;
    valueUsd: number;
  }>;
}

/**
 * Dummy wallet service for testing purposes
 * Provides mock implementations of wallet operations
 */
export class DummyWalletService extends Service {
  // Use a custom service type since WALLET isn't in ServiceType enum
  static readonly serviceType = 'wallet';

  capabilityDescription = 'Dummy wallet service for testing';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<DummyWalletService> {
    const service = new DummyWalletService(runtime);
    return service;
  }

  async stop(): Promise<void> {
    console.log('[DummyWalletService] stopped.');
  }

  async getBalance(address: string, tokenAddress?: string): Promise<bigint> {
    return BigInt(1000000);
  }

  async transfer(to: string, amount: bigint, tokenAddress?: string): Promise<string> {
    return '0xdummy-transaction-hash';
  }

  async getPortfolio(address: string): Promise<WalletPortfolio> {
    return {
      totalValueUsd: 10000,
      assets: [
        {
          symbol: 'ETH',
          balance: 1.5,
          valueUsd: 5000,
        },
        {
          symbol: 'USDC',
          balance: 5000,
          valueUsd: 5000,
        },
      ],
    };
  }

  async signMessage(message: string): Promise<string> {
    return '0xdummy-signature';
  }

  async getAddress(): Promise<string> {
    return '0xdummy-address';
  }

  getDexName(): string {
    return 'dummy-wallet';
  }
}
