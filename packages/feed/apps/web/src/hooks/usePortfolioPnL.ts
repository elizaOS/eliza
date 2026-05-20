'use client';

import type { PortfolioBreakdownSnapshot } from '@feed/engine/client';
import { useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import {
  fetchPortfolioBreakdownSnapshot,
  isAbortError,
  usePortfolioBreakdown,
  usePortfolioBreakdownPolling,
} from '@/stores/portfolioBreakdownStore';

// Re-export for components that import from this hook
export type { PortfolioBreakdownSnapshot } from '@feed/engine/client';
export { fetchPortfolioBreakdownSnapshot, isAbortError };

/**
 * Return type for the usePortfolioPnL hook.
 */
interface UsePortfolioPnLResult {
  /** Whether portfolio data is currently loading */
  loading: boolean;
  /** Any error that occurred while fetching portfolio data */
  error: string | null;
  /** Portfolio PnL snapshot containing all calculated metrics */
  data: PortfolioBreakdownSnapshot | null;
  /** Function to manually refresh portfolio data */
  refresh: () => Promise<void>;
  /** Timestamp of last successful update */
  lastUpdated: number | null;
}

interface UsePortfolioPnLOptions {
  userId?: string | null;
}

interface UsePortfolioPnLPollingOptions extends UsePortfolioPnLOptions {
  intervalMs?: number;
}

/**
 * Hook for fetching and managing portfolio profit and loss (PnL) data.
 *
 * Fetches a canonical portfolio breakdown for consistent P/L:
 * - Wallet (user-held points)
 * - Agents (agent-held points)
 * - Positions (mark-to-market value of open positions)
 * - Available (wallet + agents)
 * - Original amount (baseline)
 * - Total assets
 * - Total P/L
 */
export function usePortfolioPnL(
  options: UsePortfolioPnLOptions = {}
): UsePortfolioPnLResult {
  const { user, authenticated } = useAuth();
  const targetUserId =
    options.userId ?? (authenticated ? (user?.id ?? null) : null);
  const result = usePortfolioBreakdown(targetUserId);
  const memoizedData = useMemo(() => result.data, [result.data]);

  return {
    loading: result.loading,
    error: result.error,
    data: memoizedData,
    refresh: result.refresh,
    lastUpdated: result.lastUpdated,
  };
}

export function usePortfolioPnLPolling(
  options: UsePortfolioPnLPollingOptions = {}
) {
  const { user, authenticated } = useAuth();
  const targetUserId =
    options.userId ?? (authenticated ? (user?.id ?? null) : null);

  usePortfolioBreakdownPolling(targetUserId, options.intervalMs ?? 15000);
}
