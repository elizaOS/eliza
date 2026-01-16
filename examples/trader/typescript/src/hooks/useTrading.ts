import { useState, useEffect, useCallback } from 'react';
import type { AgentRuntime } from '@elizaos/core';
import type { AutoTradingManager } from '@elizaos/plugin-auto-trader';

interface StatusPosition {
  id: string;
  tokenAddress: string;
  symbol?: string;
  amount: number;
  entryPrice: number;
  currentPrice?: number;
}

interface Transaction {
  id: string;
  timestamp: number;
  action: string;
  token: string;
  quantity: number;
  price: number;
  reason?: string;
}

export interface TradingState {
  isTrading: boolean;
  strategy: string | null;
  positions: Array<{
    id: string;
    tokenAddress: string;
    symbol?: string;
    amount: number;
    entryPrice: number;
    currentPrice: number;
    pnl: number;
    pnlPercent: number;
  }>;
  performance: {
    totalPnL: number;
    dailyPnL: number;
    winRate: number;
    totalTrades: number;
  };
  recentTrades: Array<{
    id: string;
    timestamp: number;
    action: 'BUY' | 'SELL';
    token: string;
    quantity: number;
    price: number;
    reason?: string;
  }>;
  walletBalance: number;
  walletAddress: string | null;
}

const initialState: TradingState = {
  isTrading: false,
  strategy: null,
  positions: [],
  performance: {
    totalPnL: 0,
    dailyPnL: 0,
    winRate: 0,
    totalTrades: 0,
  },
  recentTrades: [],
  walletBalance: 0,
  walletAddress: null,
};

export function useTrading(runtime: AgentRuntime | null) {
  const [state, setState] = useState<TradingState>(initialState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch trading status from the service
  const refreshStatus = useCallback(async () => {
    if (!runtime) return;

    const tradingManager = runtime.getService('AutoTradingManager') as AutoTradingManager | undefined;
    if (!tradingManager) return;

    const status = tradingManager.getStatus();
    const transactions = tradingManager.getLatestTransactions(10);

    setState(prev => ({
      ...prev,
      isTrading: status.isTrading,
      strategy: status.strategy || null,
      positions: status.positions.map((p: StatusPosition) => {
        const currentPrice = p.currentPrice ?? p.entryPrice;
        return {
          id: p.id,
          tokenAddress: p.tokenAddress,
          amount: p.amount,
          entryPrice: p.entryPrice,
          currentPrice,
          pnl: (currentPrice - p.entryPrice) * p.amount,
          pnlPercent: (currentPrice / p.entryPrice - 1) * 100,
        };
      }),
      performance: status.performance,
      recentTrades: transactions.map((t: Transaction) => ({
        id: t.id,
        timestamp: t.timestamp,
        action: t.action as 'BUY' | 'SELL',
        token: t.token,
        quantity: t.quantity,
        price: t.price,
        reason: t.reason,
      })),
    }));
  }, [runtime]);

  // Refresh wallet balance
  const refreshWallet = useCallback(async () => {
    if (!runtime) return;

    const swapService = runtime.getService('SwapService') as unknown as { getWalletAddress(): string | null; getWalletBalances(): Promise<{ solBalance: number }> } | undefined;
    if (!swapService) return;

    const address = swapService.getWalletAddress();
    const balances = await swapService.getWalletBalances();

    setState(prev => ({
      ...prev,
      walletAddress: address,
      walletBalance: balances.solBalance,
    }));
  }, [runtime]);

  // Start trading
  const startTrading = useCallback(async (config: {
    strategy: string;
    tokens?: string[];
    maxPositionSize?: number;
    intervalMs?: number;
    stopLossPercent?: number;
    takeProfitPercent?: number;
  }) => {
    if (!runtime) {
      setError('Runtime not initialized');
      return;
    }

    setLoading(true);
    setError(null);

    const tradingManager = runtime.getService('AutoTradingManager') as AutoTradingManager | undefined;
    if (!tradingManager) {
      setError('Trading service not available');
      setLoading(false);
      return;
    }

    await tradingManager.startTrading({
      strategy: config.strategy,
      tokens: config.tokens || ['auto'],
      maxPositionSize: config.maxPositionSize || 0.15,
      intervalMs: config.intervalMs || 60000,
      stopLossPercent: config.stopLossPercent || 5,
      takeProfitPercent: config.takeProfitPercent || 15,
    });

    await refreshStatus();
    setLoading(false);
  }, [runtime, refreshStatus]);

  // Stop trading
  const stopTrading = useCallback(async () => {
    if (!runtime) return;

    setLoading(true);
    setError(null);

    const tradingManager = runtime.getService('AutoTradingManager') as AutoTradingManager | undefined;
    if (!tradingManager) {
      setError('Trading service not available');
      setLoading(false);
      return;
    }

    await tradingManager.stopTrading();
    await refreshStatus();
    setLoading(false);
  }, [runtime, refreshStatus]);

  // Set up polling for status updates
  useEffect(() => {
    if (!runtime) return;

    refreshStatus();
    refreshWallet();

    const interval = setInterval(() => {
      refreshStatus();
      refreshWallet();
    }, 5000);

    return () => clearInterval(interval);
  }, [runtime, refreshStatus, refreshWallet]);

  return {
    state,
    loading,
    error,
    startTrading,
    stopTrading,
    refreshStatus,
    refreshWallet,
  };
}
