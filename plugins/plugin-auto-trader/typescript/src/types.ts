// Import core types
import type { IAgentRuntime as AgentRuntime, UUID } from "@elizaos/core";

// Define wallet and token types locally since they're not exported from @elizaos/core
export interface TokenBalance {
  mint: string;
  balance: string;
  decimals: number;
  uiAmount: number;
}

export interface TokenData {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  price?: number;
  volume24h?: number;
  liquidity?: number;
}

export interface WalletAsset {
  mint: string;
  balance: number;
  decimals: number;
  uiAmount: number;
}

export interface IWalletService {
  getBalance(): Promise<number>;
  getTokenBalances(): Promise<TokenBalance[]>;
}

// #region --- Portfolio and Trading Data Interfaces ---

/**
 * Core types for simulations and backtesting
 */

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StrategyContextMarketData {
  currentPrice: number;
  lastPrices: number[];
  indicators?: { [indicatorName: string]: number };
  priceData?: OHLCV[]; // Full price data for custom analysis
}

export interface AgentState {
  portfolioValue: number;
  volatility: number;
  confidenceLevel: number;
  recentTrades: number;
  lastAction?: string;
  sentiment?: number;
}

export interface TradingStrategy {
  id: string;
  name: string;
  description: string;
  decide(params: {
    marketData: StrategyContextMarketData;
    agentState: AgentState;
    portfolioSnapshot: PortfolioSnapshot;
    agentRuntime?: AgentRuntime;
  }): Promise<TradeOrder | null>;
  initialize?(agentRuntime?: AgentRuntime): Promise<void>;
  isReady(): boolean;
  configure?(params: any): void;
}

export enum TradeType {
  BUY = "BUY",
  SELL = "SELL",
}

export enum OrderType {
  MARKET = "MARKET",
  LIMIT = "LIMIT",
  STOP = "STOP",
}

export interface TradeOrder {
  pair: string;
  action: TradeType;
  quantity: number;
  orderType: OrderType;
  price?: number;
  stopPrice?: number;
  timestamp: number;
  reason?: string;
}

export interface Trade extends TradeOrder {
  executedPrice: number;
  executedTimestamp: number;
  fees: number;
  feeCurrency?: string; // Add optional feeCurrency
  tradeId?: string; // Add optional tradeId
  realizedPnl?: number; // Profit or loss realized on this trade (typically for SELL trades)
}

export interface PortfolioSnapshot {
  timestamp: number;
  holdings: { [assetSymbol: string]: number };
  totalValue: number;
}

export interface PerformanceMetrics {
  totalPnlAbsolute: number;
  totalPnlPercentage: number;
  sharpeRatio?: number;
  sortinoRatio?: number;
  winLossRatio: number;
  averageWinAmount: number;
  averageLossAmount: number;
  maxDrawdown: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  firstAssetPrice?: number;
  lastAssetPrice?: number;
  buyAndHoldPnlPercentage?: number;
}

export interface SimulationReport {
  strategy: string;
  pair: string;
  startDate: number;
  endDate: number;
  trades: Trade[];
  portfolioSnapshots: PortfolioSnapshot[];
  finalPortfolioValue: number;
  metrics: PerformanceMetrics;
}

// HistoricalDataService
export interface HistoricalDataService {
  fetchData(
    pair: string,
    interval: string,
    startDate: Date,
    endDate: Date,
    dataSource: string,
  ): Promise<OHLCV[]>;
}

// #endregion --- Portfolio and Trading Data Interfaces ---

// #region --- Service & Other Interfaces ---

export interface TradeSimulationResult {
  isValid: boolean;
  reason?: string;
  updatedBalance?: number;
  updatedPortfolio?: { [assetSymbol: string]: PortfolioAssetHolding };
}

// Wallet portfolio for auto-trader
export interface WalletPortfolio {
  totalUsd: string;
  totalSol?: string;
  items: Array<{
    name: string;
    address: string;
    symbol: string;
    decimals: number;
    balance: string;
    uiAmount: string;
    priceUsd: string;
    valueUsd: string;
    valueSol?: string;
  }>;
}

export interface PortfolioAssetHolding {
  mint: string;
  balance: number;
  decimals: number;
  uiAmount: number;
  averagePrice: number;
  symbol?: string;
  assetAddress: string;
}

export interface Position {
  id: UUID;
  tokenAddress: string;
  amount: number;
  entryPrice: number;
  currentPrice?: number;
  unrealizedPnl?: number;
  realizedPnl?: number;
}

export interface WalletOperationResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
}

export interface PortfolioHolding {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  amount: number;
  decimals: number;
  usdValue: number;
  tokenPriceUsd: number;
}

export interface TrackedPosition {
  tokenAddress: string;
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  value: number;
  pnl: number;
  pnlPercentage: number;
}

// Strategy-specific parameters
export interface RandomStrategyParams {
  buyProbability?: number;
  sellProbability?: number;
  maxTradeSize?: number;
  minTradeSize?: number;
  randomSeed?: number;
}

export interface RuleBasedStrategyParams {
  indicators?: string[];
  buyConditions?: {
    [indicator: string]: { threshold: number; condition: "above" | "below" };
  };
  sellConditions?: {
    [indicator: string]: { threshold: number; condition: "above" | "below" };
  };
  riskSettings?: {
    maxPositionSize?: number;
    stopLossPercentage?: number;
    takeProfitPercentage?: number;
  };
}

export interface LLMStrategyParams {
  modelName?: string;
  customPromptPrefix?: string;
  customPromptSuffix?: string;
  maxTokens?: number;
  temperature?: number;
  defaultTradeSizePercentage?: number;
  defaultFixedTradeQuantity?: number;
  structuredOutputSchema?: any;
  systemPrompt?: string;
}

// #endregion --- Service & Other Interfaces ---
