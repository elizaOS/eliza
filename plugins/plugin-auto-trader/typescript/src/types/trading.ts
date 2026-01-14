import { type UUID } from '@elizaos/core';

// Re-export types using 'export type' for isolatedModules
export type { TokenSignal, PortfolioStatus, SellSignalMessage } from './index.ts';

// Trading-specific types not in index.ts
export interface RiskLimits {
  maxPositionSize: number;
  maxDrawdown: number;
  stopLossPercentage: number;
  takeProfitPercentage: number;
}

export interface TradingConfig {
  intervals: {
    priceCheck: number;
    walletSync: number;
    performanceMonitor: number;
  };
  thresholds: {
    minLiquidity: number;
    minVolume: number;
    minScore: number;
  };
  riskLimits: RiskLimits;
  slippageSettings: {
    baseSlippage: number;
    maxSlippage: number;
    liquidityMultiplier: number;
    volumeMultiplier: number;
  };
}

export type WalletPortfolioItem = {
  name: string;
  address: string;
  symbol: string;
  decimals: number;
  balance: string;
  uiAmount: string;
  priceUsd: string;
  valueUsd: string;
  valueSol?: string;
};

export type WalletPortfolio = {
  totalUsd: string;
  totalSol?: string;
  items: WalletPortfolioItem[];
};

export interface PortfolioAssetHolding {
  quantity: number;
  averagePrice: number;
  symbol: string;
  value?: number;
}
