import { UUID } from '@elizaos/core';

export enum ServiceTypes {
  DEGEN_TRADING = 'DEGEN_TRADING',
}

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

export interface BuySignalMessage {
  positionId: UUID;
  tokenAddress: string;
  entityId: string;
  expectedOutAmount: string;
}

export interface SellSignalMessage {
  positionId: UUID;
  tokenAddress: string;
  amount: string;
  entityId: string;
  expectedOutAmount?: string;
  currentBalance: string;
  walletAddress: string;
  isSimulation: boolean;
  sellRecommenderId: string;
  reason: string;
}

export interface PriceSignalMessage {
  tokenAddress: string;
  initialPrice: number;
  currentPrice: number;
  priceChange: number;
}

export interface PortfolioStatus {
  totalValue: number;
  positions: { [tokenAddress: string]: { amount: number; value: number } };
  solBalance: number;
  drawdown: number;
}

export interface TradePerformanceData {
  token_address: string;
  buy_price: number;
  buy_timeStamp: string;
  buy_amount: number;
  buy_value_usd: number;
  buy_market_cap: number;
  buy_liquidity: number;
  profit_usd: number;
  profit_percent: number;
  rapidDump: boolean;
}
