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
  private prices: Map<string, number> = new Map();
  private decimals: Map<string, number> = new Map();
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
    this.prices.set('USDC', 1); // USDC always has price 1
    this.decimals.set('USDC', 6);
    console.log('[DummyWalletService] started.');
  }

  async stop(): Promise<void> {
    this.balances.clear();
    this.prices.clear();
    this.decimals.clear();
    console.log('[DummyWalletService] stopped.');
  }

  async getBalance(asset: string): Promise<bigint> {
    return this.balances.get(asset) || BigInt(0);
  }

  addFunds(asset: string, amount: number): void {
    const currentBalance = this.balances.get(asset) || BigInt(0);
    this.balances.set(asset, currentBalance + BigInt(amount));
  }

  setPortfolioHolding(asset: string, amount: number, price: number = 1): void {
    if (asset === this.quoteAsset) {
      this.addFunds(asset, amount);
      this.prices.set(asset, 1); // USDC always has price 1
      this.decimals.set(asset, 6);
    } else {
      // For non-quote assets, we need to handle the amount properly
      // If amount represents the actual quantity, we store it with appropriate decimals
      const decimals = 6; // Default to 6 decimals for dummy tokens
      const scaledAmount = Math.floor(amount * Math.pow(10, decimals));
      this.balances.set(asset, BigInt(scaledAmount));
      this.prices.set(asset, price);
      this.decimals.set(asset, decimals);
    }
  }

  resetWallet(initialCash: number = 10000, quoteAsset: string = 'USDC'): void {
    this.balances.clear();
    this.prices.clear();
    this.decimals.clear();
    this.quoteAsset = quoteAsset;
    this.balances.set(quoteAsset, BigInt(initialCash * 1e6));
    this.prices.set(quoteAsset, 1); // Quote asset always has price 1
    this.decimals.set(quoteAsset, 6);
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
    const assets: any[] = [];
    let totalValueUsd = 0;

    for (const [asset, balance] of this.balances.entries()) {
      const price = this.prices.get(asset) || 1;
      const decimals = this.decimals.get(asset) || 6;
      const divisor = Math.pow(10, decimals);

      // Calculate actual quantity and value
      const quantity = Number(balance) / divisor;
      const valueUsd = quantity * price;
      totalValueUsd += valueUsd;

      assets.push({
        symbol: asset,
        address: `dummy-${asset.toLowerCase()}-address`,
        balance: Number(balance),
        valueUsd,
        value: valueUsd,
        amount: quantity,
        quantity,
        price,
        averagePrice: price, // Use current price as average for dummy service
        allocation: 0, // Will be calculated below
        decimals,
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
