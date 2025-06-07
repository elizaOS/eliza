import { Service } from './service';

/**
 * Represents a single asset holding within a wallet.
 * This provides a standardized view of a token or native currency.
 */
export interface WalletAsset {
  name: string;
  symbol: string;
  address: string; // Token mint address, or a native identifier like 'SOL' or 'ETH'
  decimals: number;
  balance: string; // Raw balance as a string to handle large numbers with precision
  uiAmount: number; // User-friendly balance, adjusted for decimals
  priceUsd?: number; // Optional price per unit in USD
  valueUsd?: number; // Optional total value in USD (uiAmount * priceUsd)
}

/**
 * Represents the entire portfolio of assets in a wallet.
 */
export interface WalletPortfolio {
  totalValueUsd: number;
  assets: WalletAsset[];
}

/**
 * Abstract interface for a Wallet Service.
 * Plugins that provide wallet functionality (e.g., for Solana, EVM) should implement this service.
 * It provides a standardized way for other plugins to query the state of a wallet.
 */
export abstract class IWalletService extends Service {
  static override readonly serviceType = 'wallet';

  public readonly capabilityDescription =
    'Provides standardized access to wallet balances and portfolios.';

  /**
   * Retrieves the entire portfolio of assets held by the wallet.
   * @param owner - Optional: The specific wallet address/owner to query if the service manages multiple.
   * @returns A promise that resolves to the wallet's portfolio.
   */
  abstract getPortfolio(owner?: string): Promise<WalletPortfolio>;

  /**
   * Retrieves the balance of a specific asset in the wallet.
   * @param assetAddress - The mint address or native identifier of the asset.
   * @param owner - Optional: The specific wallet address/owner to query.
   * @returns A promise that resolves to the user-friendly (decimal-adjusted) balance of the asset held.
   */
  abstract getBalance(assetAddress: string, owner?: string): Promise<number>;
}
