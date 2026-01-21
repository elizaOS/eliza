"use client";

import type { PerpPosition, UserPredictionPosition } from "@polyagent/shared";
import { logger } from "@polyagent/shared";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Helper to safely convert API values to numbers.
 */
function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

// Re-export for convenience
export type { UserPredictionPosition } from "@polyagent/shared";

interface PerpStats {
  totalPositions: number;
  totalPnL: number;
  totalFunding: number;
}

interface PositionsState {
  perpPositions: PerpPosition[];
  predictionPositions: UserPredictionPosition[];
  perpStats: PerpStats;
}

type NumericLike = number | string | null | undefined;

interface ApiPerpPositionPayload {
  id: string;
  userId?: string;
  ticker: string;
  organizationId?: string;
  side: PerpPosition["side"];
  entryPrice: NumericLike;
  currentPrice: NumericLike;
  size: NumericLike;
  leverage: NumericLike;
  liquidationPrice?: NumericLike;
  unrealizedPnL?: NumericLike;
  unrealizedPnLPercent?: NumericLike;
  fundingPaid?: NumericLike;
  openedAt: string;
  lastUpdated?: string;
}

interface ApiPredictionPositionPayload {
  id: string;
  marketId: string;
  question: string;
  side: UserPredictionPosition["side"];
  shares: NumericLike;
  avgPrice: NumericLike;
  currentPrice: NumericLike;
  currentValue?: NumericLike;
  costBasis?: NumericLike;
  unrealizedPnL?: NumericLike;
  currentProbability?: NumericLike;
  resolved?: boolean;
  resolution?: boolean | null;
}

/**
 * Options for configuring user positions loading.
 */
interface UseUserPositionsOptions {
  /** Whether to enable position fetching (default: true) */
  enabled?: boolean;
}

const DEFAULT_STATS: PerpStats = {
  totalPositions: 0,
  totalPnL: 0,
  totalFunding: 0,
};

const createDefaultState = (): PositionsState => ({
  perpPositions: [],
  predictionPositions: [],
  perpStats: { ...DEFAULT_STATS },
});

/**
 * Hook for fetching and managing user trading positions.
 *
 * Loads all positions (both perpetual and prediction markets) for a given user.
 * Automatically refreshes when the userId changes. Supports cancellation of
 * in-flight requests and error handling.
 *
 * @param userId - The user ID to fetch positions for, or null/undefined to clear positions
 * @param options - Configuration options including enabled flag
 *
 * @returns An object containing:
 * - `perpPositions`: Array of perpetual market positions
 * - `predictionPositions`: Array of prediction market positions
 * - `perpStats`: Aggregate statistics for perpetual positions
 * - `loading`: Whether positions are currently loading
 * - `error`: Any error that occurred while fetching
 * - `refresh`: Function to manually refresh positions
 *
 * @example
 * ```tsx
 * const { perpPositions, predictionPositions, loading } = useUserPositions(userId);
 *
 * if (loading) return <div>Loading positions...</div>;
 *
 * return (
 *   <div>
 *     <h2>Perpetual Positions: {perpPositions.length}</h2>
 *     <h2>Prediction Positions: {predictionPositions.length}</h2>
 *   </div>
 * );
 * ```
 */
export function useUserPositions(
  userId?: string | null,
  options: UseUserPositionsOptions = {},
) {
  const { enabled = true } = options;
  const [state, setState] = useState<PositionsState>(createDefaultState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!userId || !enabled) {
      setState(createDefaultState());
      setLoading(false);
      setError(null);
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/markets/positions/${encodeURIComponent(userId)}`,
        { signal: controller.signal },
      );

      // Check if request was aborted before parsing
      if (controller.signal.aborted) {
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage =
          typeof errorData.error === "string"
            ? errorData.error
            : `Failed to fetch positions: ${response.status}`;
        throw new Error(errorMessage);
      }

      const data = await response.json();

      // Check if request was aborted after parsing
      if (controller.signal.aborted) {
        return;
      }

      const perpetuals = data?.perpetuals ?? {};
      const predictions = data?.predictions ?? {};

      const normalizedPerps = (perpetuals.positions ?? []).map(
        (pos: ApiPerpPositionPayload) => ({
          id: pos.id,
          userId: pos.userId,
          ticker: pos.ticker,
          organizationId: pos.organizationId,
          side: pos.side,
          entryPrice: toNumber(pos.entryPrice),
          currentPrice: toNumber(pos.currentPrice),
          size: toNumber(pos.size),
          leverage: toNumber(pos.leverage),
          liquidationPrice: toNumber(pos.liquidationPrice),
          unrealizedPnL: toNumber(pos.unrealizedPnL),
          unrealizedPnLPercent: toNumber(pos.unrealizedPnLPercent),
          fundingPaid: toNumber(pos.fundingPaid),
          openedAt: pos.openedAt,
          lastUpdated: pos.lastUpdated ?? pos.openedAt,
        }),
      ) as PerpPosition[];

      const normalizedPredictions = (predictions.positions ?? []).map(
        (pos: ApiPredictionPositionPayload) => {
          const shares = toNumber(pos.shares);
          const avgPrice = toNumber(pos.avgPrice);
          return {
            id: pos.id,
            marketId: pos.marketId,
            question: pos.question,
            side: pos.side,
            shares,
            avgPrice,
            currentPrice: toNumber(pos.currentPrice),
            currentValue: toNumber(pos.currentValue ?? 0),
            costBasis: toNumber(pos.costBasis ?? shares * avgPrice),
            unrealizedPnL: toNumber(pos.unrealizedPnL ?? 0),
            resolved: Boolean(pos.resolved),
            resolution: pos.resolution ?? null,
          };
        },
      ) as UserPredictionPosition[];

      setState({
        perpPositions: normalizedPerps,
        predictionPositions: normalizedPredictions,
        perpStats: perpetuals.stats ?? { ...DEFAULT_STATS },
      });
      setError(null);
    } catch (err) {
      // Ignore abort errors - these are expected during cleanup
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }

      const error =
        err instanceof Error ? err : new Error("Failed to fetch positions");
      logger.error(
        "Failed to fetch user positions",
        { userId, error },
        "useUserPositions",
      );
      setError(error);
      setState(createDefaultState());
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [userId, enabled]);

  useEffect(() => {
    if (enabled && userId) {
      void refresh();
    } else {
      setState(createDefaultState());
      setLoading(false);
      setError(null);
    }

    return () => {
      controllerRef.current?.abort();
    };
  }, [refresh, enabled, userId]);

  return {
    perpPositions: state.perpPositions,
    predictionPositions: state.predictionPositions,
    perpStats: state.perpStats,
    loading,
    error,
    refresh,
  };
}
