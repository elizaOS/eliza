declare module '@elizaos/plugin-auto-trader' {
  import type { Plugin, Service } from '@elizaos/core';

  export interface TradingPosition {
    id: string;
    tokenAddress: string;
    symbol?: string;
    amount: number;
    entryPrice: number;
    currentPrice?: number;
  }

  export interface TradingPerformance {
    totalPnL: number;
    dailyPnL: number;
    winRate: number;
    totalTrades: number;
  }

  export interface TradingStatus {
    isTrading: boolean;
    strategy?: string;
    positions: TradingPosition[];
    performance: TradingPerformance;
  }

  export interface TradingTransaction {
    id: string;
    timestamp: number;
    action: string;
    token: string;
    quantity: number;
    price: number;
    reason?: string;
  }

  export interface TradingConfig {
    strategy: string;
    tokens: string[];
    maxPositionSize: number;
    intervalMs: number;
    stopLossPercent: number;
    takeProfitPercent: number;
  }

  export interface AutoTradingManager extends Service {
    getStatus(): TradingStatus;
    getLatestTransactions(count: number): TradingTransaction[];
    startTrading(config: TradingConfig): Promise<void>;
    stopTrading(): Promise<void>;
  }

  const plugin: Plugin;
  export default plugin;
}
