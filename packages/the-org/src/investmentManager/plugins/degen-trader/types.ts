import { IAgentRuntime } from '@elizaos/core';

// Token Security Types
export interface TokenSecurityData {
  ownerBalance: string;
  creatorBalance: string;
  ownerPercentage: number;
  creatorPercentage: number;
  top10HolderBalance: string;
  top10HolderPercent: number;
}

// Token Trading Types
export interface TokenTradeData {
  price: number;
  priceChange24h: number;
  volume24h: number;
  volume24hUsd: string;
  uniqueWallets24h: number;
  uniqueWallets24hChange: number;
}

export interface DexScreenerPair {
  priceUsd: number;
  volume: { h24: number };
  marketCap: number;
  liquidity: { usd: number; base: number };
  priceChange: { h24: number };
  txns: { h24: { buys: number; sells: number } };
}

export interface ProcessedTokenData {
  security: TokenSecurityData;
  tradeData: TokenTradeData;
  dexScreenerData: { pairs: DexScreenerPair[] };
  holderDistributionTrend: string;
  highValueHolders: any[];
  recentTrades: boolean;
  highSupplyHoldersCount: number;
}

// Market and Position Types
export type MarketData = {
  priceChange24h: number;
  volume24h: number;
  liquidity: {
    usd: number;
  };
};

export type Position = {
  token: string;
  tokenAddress: string;
  entryPrice: number;
  amount: number;
  timestamp: number;
  sold?: boolean;
  exitPrice?: number;
  exitTimestamp?: number;
  initialMetrics: {
    trustScore: number;
    volume24h: number;
    liquidity: { usd: number };
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  };
  highestPrice?: number;
  partialTakeProfit?: boolean;
};

// Analysis Types
export type TokenAnalysis = {
  security: {
    ownerBalance: string;
    creatorBalance: string;
    ownerPercentage: number;
    top10HolderPercent: number;
  };
  trading: {
    price: number;
    priceChange24h: number;
    volume24h: number;
    uniqueWallets24h: number;
    walletChanges: {
      unique_wallet_30m_change_percent: number;
      unique_wallet_1h_change_percent: number;
      unique_wallet_24h_change_percent: number;
    };
  };
  market: {
    liquidity: number;
    marketCap: number;
    fdv: number;
  };
};

export interface TokenAnalysisState {
  lastAnalyzedIndex: number;
  analyzedTokens: Set<string>;
}

// Signal Types
export interface BuySignalMessage {
  positionId: string;
  tokenAddress: string;
  tradeAmount: string;
  expectedOutAmount: string;
  entityId: string;
}

export interface SellSignalMessage {
  positionId: string;
  tokenAddress: string;
  pairId?: string;
  amount: string;
  currentBalance?: string;
  sellRecommenderId?: string;
  walletAddress?: string;
  isSimulation?: boolean;
  reason?: string;
  entityId?: string;
}

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  walletAddress: string;
  slippageBps: number;
}

export interface StartProcessParams {
  id: string;
  tokenAddress: string;
  balance: string;
  isSimulation: boolean;
  initialMarketCap: string;
  entityId: string;
  walletAddress?: string;
  txHash?: string;
}

export interface AddTransactionParams {
  id: string;
  address: string;
  amount: string;
  walletAddress: string;
  isSimulation: boolean;
  marketCap: number;
  entityId: string;
  txHash: string;
}

export interface PriceSignalMessage {
  initialPrice: string;
  currentPrice: string;
  priceChange: number;
  tokenAddress: string;
}

export interface StartDegenProcessParams extends StartProcessParams {
  initialPrice: string;
}

export interface ITradeService {
  dataService: {
    getTokensMarketData: (tokens: string[]) => Promise<any>;
  };
}

export const ServiceTypes = {
  DEGEN_TRADING: 'degen_trader',
} as const;
