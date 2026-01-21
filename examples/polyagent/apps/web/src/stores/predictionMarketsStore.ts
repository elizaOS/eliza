/**
 * Prediction Markets Store - Centralized state management for prediction markets data
 *
 * This store prevents duplicate API calls by:
 * 1. Caching data with a TTL (10 seconds)
 * 2. Deduplicating concurrent requests via a fetchPromise
 * 3. Providing a single polling mechanism that all components share
 *
 * Usage:
 * ```tsx
 * import { usePredictionMarkets, usePredictionMarketsPolling } from '@/stores/predictionMarketsStore';
 *
 * function MyComponent() {
 *   const { markets, loading, error, refetch } = usePredictionMarkets();
 *   usePredictionMarketsPolling(30000); // Optional: enable polling every 30s
 *   return <div>{markets.map(m => ...)}</div>;
 * }
 * ```
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { PredictionMarket } from "@/types/markets";
import { MARKETS_CONFIG } from "@/types/markets";

// Re-export for backwards compatibility
export type { PredictionMarket } from "@/types/markets";

interface PredictionMarketsState {
  // Data
  markets: PredictionMarket[];
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;

  // Internal state for request deduplication
  fetchPromise: Promise<void> | null;
  pollingInterval: ReturnType<typeof setInterval> | null;
  subscriberCount: number;

  // Actions
  fetchMarkets: (force?: boolean, userId?: string) => Promise<void>;
  subscribe: (intervalMs: number, userId?: string) => () => void;
}

// Use centralized cache TTL
const CACHE_TTL = MARKETS_CONFIG.CACHE_TTL_MS;

export const usePredictionMarketsStore = create<PredictionMarketsState>(
  (set, get) => ({
    markets: [],
    loading: false,
    error: null,
    lastFetchedAt: null,
    fetchPromise: null,
    pollingInterval: null,
    subscriberCount: 0,

    fetchMarkets: async (force = false, userId?: string) => {
      const state = get();

      // Return existing promise if already fetching (deduplication)
      if (state.fetchPromise) {
        return state.fetchPromise;
      }

      // Return cached data if fresh and not forced
      if (
        !force &&
        state.lastFetchedAt &&
        Date.now() - state.lastFetchedAt < CACHE_TTL &&
        state.markets.length > 0
      ) {
        return;
      }

      // Create and store the fetch promise
      const fetchPromise = (async () => {
        // Only show loading on initial fetch (not background refreshes)
        if (state.markets.length === 0) {
          set({ loading: true });
        }
        set({ error: null });

        const url = userId
          ? `/api/markets/predictions?userId=${encodeURIComponent(userId)}`
          : "/api/markets/predictions";
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch prediction markets: ${response.status}`,
          );
        }

        const data = await response.json();
        if (data.questions && Array.isArray(data.questions)) {
          set({
            markets: data.questions,
            lastFetchedAt: Date.now(),
            error: null,
          });
        }
        set({ loading: false, fetchPromise: null });
      })();

      set({ fetchPromise });
      return fetchPromise;
    },

    // Combined subscribe/unsubscribe that handles polling lifecycle
    subscribe: (intervalMs: number, userId?: string) => {
      const state = get();
      const newCount = state.subscriberCount + 1;
      set({ subscriberCount: newCount });

      // Start polling on first subscriber
      if (newCount === 1) {
        // Initial fetch
        get().fetchMarkets(false, userId);

        // Set up interval
        const interval = setInterval(() => {
          get().fetchMarkets(true, userId);
        }, intervalMs);

        set({ pollingInterval: interval });
      }

      // Return unsubscribe function
      return () => {
        const currentState = get();
        const updatedCount = currentState.subscriberCount - 1;
        set({ subscriberCount: updatedCount });

        // Stop polling when last subscriber leaves
        if (updatedCount === 0 && currentState.pollingInterval) {
          clearInterval(currentState.pollingInterval);
          set({ pollingInterval: null });
        }
      };
    },
  }),
);

// Selector for data (memoized by zustand)
const dataSelector = (state: PredictionMarketsState) => ({
  markets: state.markets,
  loading: state.loading,
  error: state.error,
});

/**
 * Hook for consuming prediction markets data
 * Automatically fetches data on mount if not cached
 */
export function usePredictionMarkets(userId?: string) {
  // Single subscription with shallow comparison for the object
  const { markets, loading, error } = usePredictionMarketsStore(
    useShallow(dataSelector),
  );
  const fetchMarkets = usePredictionMarketsStore((state) => state.fetchMarkets);

  // Fetch on mount if needed
  useEffect(() => {
    fetchMarkets(false, userId);
  }, [fetchMarkets, userId]);

  const refetch = useCallback(() => {
    return fetchMarkets(true, userId);
  }, [fetchMarkets, userId]);

  return { markets, loading, error, refetch };
}

/**
 * Hook for enabling polling on prediction markets
 * Uses reference counting so multiple components can request polling
 * and it only stops when all components unmount
 *
 * @param intervalMs - Polling interval in milliseconds (default: 30000)
 * @param userId - Optional user ID for fetching with positions
 */
export function usePredictionMarketsPolling(
  intervalMs = 30000,
  userId?: string,
) {
  const subscribe = usePredictionMarketsStore((state) => state.subscribe);

  // Store params in refs so they don't cause re-subscriptions
  const intervalRef = useRef(intervalMs);
  const userIdRef = useRef(userId);

  useEffect(() => {
    // Subscribe returns the unsubscribe function
    const unsubscribe = subscribe(intervalRef.current, userIdRef.current);
    return unsubscribe;
  }, [subscribe]);
}

/**
 * Get a specific market by ID (memoized)
 */
export function usePredictionMarket(marketId: string | number) {
  const { markets, loading, error, refetch } = usePredictionMarkets();

  const market = useMemo(
    () => markets.find((m) => m.id.toString() === marketId.toString()),
    [markets, marketId],
  );

  return { market, loading, error, refetch };
}

/**
 * Get active markets only (memoized)
 */
export function useActivePredictionMarkets() {
  const { markets, loading, error, refetch } = usePredictionMarkets();

  const activeMarkets = useMemo(
    () => markets.filter((m) => m.status === "active"),
    [markets],
  );

  return { markets: activeMarkets, loading, error, refetch };
}

/**
 * Get market statistics (memoized)
 */
export function usePredictionMarketsStats() {
  const { markets, loading } = usePredictionMarkets();

  const stats = useMemo(
    () => ({
      total: markets.length,
      active: markets.filter((m) => m.status === "active").length,
      resolved: markets.filter((m) => m.status === "resolved").length,
      totalVolume: markets.reduce(
        (sum, m) => sum + (m.yesShares || 0) + (m.noShares || 0),
        0,
      ),
    }),
    [markets],
  );

  return { stats, loading };
}
