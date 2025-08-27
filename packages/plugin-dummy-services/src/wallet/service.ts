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
  private balances: Map<string, bigint> = new Map();
  private quoteAsset = 'USDC';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<DummyWalletService> {
    const service = new DummyWalletService(runtime);
    await service.start();
    return service;
  }

  async start(): Promise<void> {
    // Initialize with default USDC balance
    this.balances.set('USDC', BigInt(10000 * 1e6)); // 10,000 USDC with 6 decimals
    console.log('[DummyWalletService] started.');
  }

  async stop(): Promise<void> {
    this.balances.clear();
    console.log('[DummyWalletService] stopped.');
  }

  async getBalance(asset: string): Promise<bigint> {
    return this.balances.get(asset) || BigInt(0);
  }

  addFunds(asset: string, amount: number): void {
    const currentBalance = this.balances.get(asset) || BigInt(0);
    this.balances.set(asset, currentBalance + BigInt(amount));
  }

  setPortfolioHolding(asset: string, amount: number, price?: number): void {
    if (asset === this.quoteAsset) {
      this.addFunds(asset, amount);
    } else {
      this.balances.set(asset, BigInt(amount));
    }
  }

  resetWallet(initialCash: number = 10000, quoteAsset: string = 'USDC'): void {
    this.balances.clear();
    this.quoteAsset = quoteAsset;
    this.balances.set(quoteAsset, BigInt(initialCash * 1e6));
  }

  async transferSol(from: string, to: string, amount: number): Promise<string> {
    const amountBigInt = BigInt(amount);
    const solBalance = this.balances.get('SOL') || BigInt(0);
    if (solBalance < amountBigInt) {
      throw new Error(`Insufficient SOL balance`);
    }
    this.balances.set('SOL', solBalance - amountBigInt);
    return `dummy-tx-${Date.now()}`;
  }

  getPortfolio(): any {
    const assets = [];
    let totalValueUsd = 0;

    for (const [asset, balance] of this.balances.entries()) {
      const valueUsd = Number(balance) / 1e6; // Simplified: assume 6 decimals and 1:1 USD value
      totalValueUsd += valueUsd;

      assets.push({
        symbol: asset,
        address: `dummy-${asset.toLowerCase()}-address`,
        balance: Number(balance),
        valueUsd,
        value: valueUsd,
        amount: Number(balance) / 1e6,
        quantity: Number(balance) / 1e6,
        price: 1, // Dummy price
        averagePrice: 1, // Dummy average price
        allocation: 0, // Will be calculated below
        decimals: 6, // Assume 6 decimals for all dummy tokens
      });
    }

    // Calculate allocations
    for (const asset of assets) {
      asset.allocation = totalValueUsd > 0 ? (asset.valueUsd / totalValueUsd) * 100 : 0;
    }

    return {
      totalValueUsd,
      assets,
      timestamp: Date.now(),
    };
  }

  get serviceName(): string {
    return 'dummy-wallet';
  }
}
