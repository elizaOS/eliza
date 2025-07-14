import { AgentRuntime, IWalletService, ServiceType, WalletPortfolio } from '@elizaos/core';

const DEFAULT_QUOTE_ASSET = 'USDC'; // Default asset for cash
const DEFAULT_TRANSACTION_FEE_FIXED = 0.1; // Example fixed fee in quote asset

interface DummyPositionLot {
  price: number;
  quantity: number;
  timestamp: number;
}

interface DummyAssetDetail {
  quantity: number;
  averagePrice: number; // Average price of current holdings
  lots: DummyPositionLot[]; // For FIFO P&L on sell
}

export class DummyWalletService extends IWalletService {
  public static override readonly serviceType = ServiceType.WALLET;

  private balances: Map<string, number>; // assetSymbolOrAddress -> quantity
  private positions: Map<string, DummyAssetDetail>; // assetSymbolOrAddress -> details for owned non-quote assets
  private quoteAssetSymbol: string;

  constructor(runtime: AgentRuntime) {
    super(runtime);
    this.balances = new Map<string, number>();
    this.positions = new Map<string, DummyAssetDetail>();
    this.quoteAssetSymbol = DEFAULT_QUOTE_ASSET;
    this.resetWallet(10000, DEFAULT_QUOTE_ASSET); // Initialize with some default cash
  }
  async transferSol(from: any, to: any, lamports: number): Promise<string> {
    // This is a dummy implementation - no real transfer happens
    console.log(
      `[${DummyWalletService.serviceType}] Mock transfer: ${lamports} lamports from ${from} to ${to}`
    );

    // For dummy wallet, we just simulate the transfer
    const solSymbol = 'SOL';
    const solAmount = lamports / 1e9; // Convert lamports to SOL

    const currentBalance = this.balances.get(solSymbol) || 0;
    if (currentBalance < solAmount) {
      throw new Error(`Insufficient SOL balance. Have ${currentBalance}, need ${solAmount}`);
    }

    // Deduct from balance
    this.balances.set(solSymbol, currentBalance - solAmount);

    // Return a dummy transaction signature
    return `dummy-tx-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  public static async start(runtime: AgentRuntime): Promise<DummyWalletService> {
    console.log(`[${DummyWalletService.serviceType}] static start called - creating instance.`);
    const instance = new DummyWalletService(runtime);
    // No further async init in instance.start() currently needed for this simple map-based wallet
    return instance;
  }

  public async start(): Promise<void> {
    console.log(
      `[${DummyWalletService.serviceType}] instance start called. Initialized with ${this.balances.get(this.quoteAssetSymbol)} ${this.quoteAssetSymbol}.`
    );
  }

  public async stop(): Promise<void> {
    console.log(`[${DummyWalletService.serviceType}] instance stop called. Balances reset.`);
    this.balances.clear();
    this.positions.clear();
  }

  async addFunds(
    assetSymbolOrAddress: string,
    amount: number,
    _walletAddress?: string
  ): Promise<void> {
    const currentBalance = this.balances.get(assetSymbolOrAddress) || 0;
    this.balances.set(assetSymbolOrAddress, currentBalance + amount);
    console.log(
      `[${DummyWalletService.serviceType}] Added ${amount} ${assetSymbolOrAddress}. New balance: ${this.balances.get(assetSymbolOrAddress)}`
    );
  }

  async setPortfolioHolding(
    assetSymbolOrAddress: string,
    quantity: number,
    averagePrice: number,
    _walletAddress?: string
  ): Promise<void> {
    if (assetSymbolOrAddress === this.quoteAssetSymbol) {
      console.warn(
        `[${DummyWalletService.serviceType}] Cannot set portfolio holding for quote asset directly, use addFunds.`
      );
      return this.addFunds(assetSymbolOrAddress, quantity * averagePrice); // Assuming quantity is amount of quote to add
    }
    this.balances.set(assetSymbolOrAddress, quantity);
    this.positions.set(assetSymbolOrAddress, {
      quantity: quantity,
      averagePrice: averagePrice,
      lots: [{ price: averagePrice, quantity: quantity, timestamp: Date.now() }], // Create a single lot for simplicity
    });
    console.log(
      `[${DummyWalletService.serviceType}] Set holding for ${assetSymbolOrAddress}: ${quantity} @ ${averagePrice}`
    );
  }

  async resetWallet(
    initialCashAmount: number,
    cashAssetSymbol: string = DEFAULT_QUOTE_ASSET,
    _walletAddress?: string
  ): Promise<void> {
    this.balances.clear();
    this.positions.clear();
    this.quoteAssetSymbol = cashAssetSymbol;
    this.balances.set(this.quoteAssetSymbol, initialCashAmount);
    console.log(
      `[${DummyWalletService.serviceType}] Wallet reset. Cash: ${initialCashAmount} ${this.quoteAssetSymbol}`
    );
  }

  async getBalance(assetSymbolOrAddress: string, _walletAddress?: string): Promise<number> {
    return this.balances.get(assetSymbolOrAddress) || 0;
  }

  async getPortfolio(_walletAddress?: string): Promise<WalletPortfolio> {
    const assets: any[] = [];
    let totalValueUsd = 0;

    for (const [symbol, balance] of this.balances) {
      const positionDetail = this.positions.get(symbol);
      const isQuoteAsset = symbol === this.quoteAssetSymbol;
      const averagePrice = positionDetail?.averagePrice || (isQuoteAsset ? 1 : 0);
      const value = isQuoteAsset
        ? balance
        : positionDetail
          ? balance * positionDetail.averagePrice
          : 0;

      // WalletAsset structure
      assets.push({
        address: symbol, // Using symbol as address for dummy wallet
        symbol,
        balance: balance.toString(),
        decimals: isQuoteAsset ? 6 : 9, // Default decimals
        quantity: balance,
        averagePrice,
        currentPrice: undefined,
        value,
        assetAddress: symbol,
      });

      totalValueUsd += value;
    }

    return {
      totalValueUsd,
      assets,
    };
  }
}
