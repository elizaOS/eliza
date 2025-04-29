import { type UUID } from '@elizaos/core';

export interface TokenSignal {
  address: string;
  symbol: string;
  marketCap: number;
  volume24h: number;
  price: number;
  liquidity: number;
  score: number;
  reasons: string[];
  technicalSignals?: {
    rsi: number;
    macd: {
      value: number;
      signal: number;
      histogram: number;
    };
    volumeProfile: {
      trend: 'increasing' | 'decreasing' | 'stable';
      unusualActivity: boolean;
    };
    volatility: number;
  };
  socialMetrics?: {
    mentionCount: number;
    sentiment: number;
    influencerMentions: number;
  };
  cmcMetrics?: {
    rank: number;
    priceChange24h: number;
    volumeChange24h: number;
  };
}

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

export interface PortfolioStatus {
  totalValue: number;
  positions: { [tokenAddress: string]: { amount: number; value: number } };
  solBalance: number;
  drawdown: number;
}

export interface SellSignalMessage {
  positionId: UUID;
  tokenAddress: string;
  amount: string;
  entityId: string;
  expectedOutAmount?: string;
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
