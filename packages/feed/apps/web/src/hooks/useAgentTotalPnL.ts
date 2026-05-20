'use client';

import { useMemo } from 'react';
import { useUserPositions } from '@/hooks/useUserPositions';

interface UseAgentTotalPnLOptions {
  /** Agent ID to fetch positions for */
  agentId: string | undefined;
  /** Available balance (virtualBalance) */
  availableBalance?: number;
  /** Total amount deposited to the agent */
  totalDeposited?: number;
  /** Total amount withdrawn from the agent */
  totalWithdrawn?: number;
  /** Fallback: Realized P&L from the agent record (lifetimePnL field) - used if deposits not available */
  realizedPnL?: string | number;
}

/**
 * Hook to calculate an agent's true P&L.
 *
 * If totalDeposited is provided and finite, calculates true P&L as:
 *   truePnL = totalPortfolio - netContributions
 *           = (availableBalance + pointsInPositions) - (totalDeposited - totalWithdrawn)
 *
 * This gives the actual gain/loss regardless of trade accounting quirks.
 * Falls back to realized + unrealized if totalDeposited is undefined or non-finite.
 * totalWithdrawn defaults to 0 if undefined or non-finite.
 *
 * @example
 * ```tsx
 * const { totalPnL, loading } = useAgentTotalPnL({
 *   agentId: agent.id,
 *   availableBalance: agent.virtualBalance,
 *   totalDeposited: agent.totalDeposited,
 *   totalWithdrawn: agent.totalWithdrawn,
 *   realizedPnL: agent.lifetimePnL,
 * });
 * ```
 */
export function useAgentTotalPnL(
  optionsOrAgentId: UseAgentTotalPnLOptions | string | undefined,
  legacyRealizedPnL?: string | number
) {
  // Support both new object API and legacy (agentId, realizedPnL) signature
  const options: UseAgentTotalPnLOptions =
    typeof optionsOrAgentId === 'object' && optionsOrAgentId !== null
      ? optionsOrAgentId
      : {
          agentId: optionsOrAgentId,
          realizedPnL: legacyRealizedPnL,
        };

  const {
    agentId,
    availableBalance = 0,
    totalDeposited,
    totalWithdrawn = 0,
    realizedPnL,
  } = options;
  const {
    predictionPositions: predictions,
    perpPositions: perps,
    loading: positionsLoading,
    error: positionsError,
  } = useUserPositions(agentId);

  // Calculate unrealized P&L and points in positions in a single pass
  // Uses explicit Number coercion with isFinite checks to prevent NaN propagation
  const { unrealizedPnL, pointsInPositions } = useMemo(() => {
    let predictionPnL = 0;
    let predictionValue = 0;

    for (const pos of predictions) {
      const unrealized = Number(pos.unrealizedPnL);
      predictionPnL += Number.isFinite(unrealized) ? unrealized : 0;

      const currentVal = Number(pos.currentValue);
      if (Number.isFinite(currentVal)) {
        predictionValue += currentVal;
      } else {
        const shares = Number(pos.shares);
        const price = Number(pos.currentPrice);
        if (Number.isFinite(shares) && Number.isFinite(price)) {
          predictionValue += shares * price;
        }
      }
    }

    let perpPnL = 0;
    let perpValue = 0;

    for (const pos of perps) {
      const unrealized = Number(pos.unrealizedPnL);
      const unrealizedSafe = Number.isFinite(unrealized) ? unrealized : 0;
      perpPnL += unrealizedSafe;

      const leverage = Number(pos.leverage);
      const size = Number(pos.size);
      if (Number.isFinite(leverage) && leverage > 0 && Number.isFinite(size)) {
        // Include margin (collateral) + unrealized P&L for consistent portfolio value
        // This matches prediction positions which use currentValue (cost + unrealized)
        const margin = Math.abs(size / leverage);
        perpValue += margin + unrealizedSafe;
      }
    }

    return {
      unrealizedPnL: predictionPnL + perpPnL,
      pointsInPositions: predictionValue + perpValue,
    };
  }, [predictions, perps]);

  // Guard against non-finite numbers to prevent NaN propagation
  const realizedRaw =
    typeof realizedPnL === 'string'
      ? parseFloat(realizedPnL ?? '0')
      : Number(realizedPnL ?? 0);
  const realized = Number.isFinite(realizedRaw) ? realizedRaw : 0;

  // Calculate total portfolio value
  const totalPortfolio = availableBalance + pointsInPositions;

  // Sanitize deposit/withdrawal values to prevent NaN propagation
  const depositedRaw = Number(totalDeposited);
  const withdrawnRaw = Number(totalWithdrawn);
  const depositedSafe = Number.isFinite(depositedRaw)
    ? depositedRaw
    : undefined;
  const withdrawnSafe = Number.isFinite(withdrawnRaw) ? withdrawnRaw : 0;

  // Calculate net contributions (what was actually put in)
  // Only computed when totalDeposited is a valid finite number
  const netContributions =
    depositedSafe !== undefined ? depositedSafe - withdrawnSafe : undefined;

  // True P&L = Current Portfolio - Net Contributions
  // This gives the actual gain/loss regardless of trade accounting quirks.
  // Falls back to realized + unrealized if deposit data isn't available.
  const totalPnL =
    netContributions !== undefined
      ? totalPortfolio - netContributions
      : realized + unrealizedPnL;

  // Defer profitability determination until positions are loaded to avoid color flash
  const isProfitable = positionsLoading ? realized >= 0 : totalPnL >= 0;

  return {
    /** Realized P&L (from closed trades) - may be inaccurate, prefer totalPnL */
    realizedPnL: realized,
    /** Unrealized P&L (from open positions) */
    unrealizedPnL,
    /** True total P&L (portfolio - contributions, or realized + unrealized as fallback) */
    totalPnL,
    /** Total value of open positions */
    pointsInPositions,
    /** Total portfolio value (available + in positions) */
    totalPortfolio,
    /** Net contributions (deposited - withdrawn), undefined if not available */
    netContributions,
    /** Whether total P&L is positive (defers to realized while loading) */
    isProfitable,
    /** Whether positions are still loading */
    loading: positionsLoading,
    /** Error from fetching positions */
    error: positionsError,
    /** Prediction positions */
    predictions,
    /** Perpetual positions */
    perps,
  };
}
