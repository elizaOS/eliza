/**
 * Perp Markets Store - Centralized state management for perpetual markets data
 *
 * This store prevents duplicate API calls by:
 * 1. Caching data with a TTL (10 seconds)
 * 2. Deduplicating concurrent requests via a fetchPromise
 * 3. Providing a single polling mechanism that all components share
 * 4. Supporting real-time SSE updates via updateMarketStats
 *
 * Usage:
 * ```tsx
 * import { usePerpMarkets, usePerpMarketsPolling, usePerpMarketsRealtime } from '@/stores/perpMarketsStore';
 *
 * function MyComponent() {
 *   const { markets, loading, error, refetch } = usePerpMarkets();
 *   usePerpMarketsPolling(30000); // Optional: enable polling every 30s
 *   usePerpMarketsRealtime(); // Optional: enable SSE real-time updates
 *   return <div>{markets.map(m => ...)}</div>;
 * }
 * ```
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  type PerpPriceUpdateSSE,
  type PerpTradeSSE,
  usePerpMarketsSubscription,
  usePerpPriceSubscription,
} from "@/hooks/usePerpMarketStream";
import type { PerpMarket } from "@/types/markets";
import { MARKETS_CONFIG } from "@/types/markets";

// Re-export for backwards compatibility
export type { PerpMarket } from "@/types/markets";

/**
 * Partial update for market stats (from SSE events).
 */
interface MarketStatsUpdate {
  currentPrice?: number;
  changePercent24h?: number;
  openInterest?: number;
  volume24h?: number;
}

interface PerpMarketsState {
  // Data
  markets: PerpMarket[];
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;

  // Internal state for request deduplication
  fetchPromise: Promise<void> | null;
  pollingInterval: ReturnType<typeof setInterval> | null;
  subscriberCount: number;

  // Actions
  fetchMarkets: (force?: boolean) => Promise<void>;
  subscribe: (intervalMs: number) => () => void;
  /** Invalidate cache to force next fetch */
  invalidateCache: () => void;
  /** Update specific market stats (from SSE) without full refetch */
  updateMarketStats: (ticker: string, stats: MarketStatsUpdate) => void;
}

// Use centralized cache TTL
const CACHE_TTL = MARKETS_CONFIG.CACHE_TTL_MS;

export const usePerpMarketsStore = create<PerpMarketsState>((set, get) => ({
  markets: [],
  loading: false,
  error: null,
  lastFetchedAt: null,
  fetchPromise: null,
  pollingInterval: null,
  subscriberCount: 0,

  fetchMarkets: async (force = false) => {
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

      try {
        const response = await fetch("/api/markets/perps");
        if (!response.ok) {
          throw new Error(`Failed to fetch perp markets: ${response.status}`);
        }

        const data = await response.json();
        if (data.markets && Array.isArray(data.markets)) {
          set({
            markets: data.markets,
            lastFetchedAt: Date.now(),
            error: null,
          });
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to fetch markets";
        set({ error: errorMessage });
      } finally {
        set({ loading: false, fetchPromise: null });
      }
    })();

    set({ fetchPromise });
    return fetchPromise;
  },

  // Combined subscribe/unsubscribe that handles polling lifecycle
  subscribe: (intervalMs: number) => {
    const state = get();
    const newCount = state.subscriberCount + 1;
    set({ subscriberCount: newCount });

    // Start polling on first subscriber
    if (newCount === 1) {
      // Initial fetch
      get().fetchMarkets();

      // Set up interval
      const interval = setInterval(() => {
        get().fetchMarkets(true);
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

  invalidateCache: () => {
    set({ lastFetchedAt: null });
  },

  updateMarketStats: (ticker: string, stats: MarketStatsUpdate) => {
    const state = get();
    const upperTicker = ticker.toUpperCase();

    const updatedMarkets = state.markets.map((market) => {
      if (market.ticker.toUpperCase() !== upperTicker) {
        return market;
      }

      return {
        ...market,
        ...(stats.currentPrice !== undefined && {
          currentPrice: stats.currentPrice,
        }),
        ...(stats.changePercent24h !== undefined && {
          changePercent24h: stats.changePercent24h,
        }),
        ...(stats.openInterest !== undefined && {
          openInterest: stats.openInterest,
        }),
        ...(stats.volume24h !== undefined && { volume24h: stats.volume24h }),
      };
    });

    set({ markets: updatedMarkets });
  },
}));

// Selector for data (memoized by zustand)
const dataSelector = (state: PerpMarketsState) => ({
  markets: state.markets,
  loading: state.loading,
  error: state.error,
});

/**
 * Hook for consuming perp markets data
 * Automatically fetches data on mount if not cached
 */
export function usePerpMarkets() {
  // Single subscription with shallow comparison for the object
  const { markets, loading, error } = usePerpMarketsStore(
    useShallow(dataSelector),
  );
  const fetchMarkets = usePerpMarketsStore((state) => state.fetchMarkets);

  // Fetch on mount if needed
  useEffect(() => {
    fetchMarkets();
  }, [fetchMarkets]);

  const refetch = useCallback(() => {
    return fetchMarkets(true);
  }, [fetchMarkets]);

  return { markets, loading, error, refetch };
}

/**
 * Hook for enabling polling on perp markets
 * Uses reference counting so multiple components can request polling
 * and it only stops when all components unmount
 *
 * @param intervalMs - Polling interval in milliseconds (default: 30000)
 */
export function usePerpMarketsPolling(intervalMs = 30000) {
  const subscribe = usePerpMarketsStore((state) => state.subscribe);

  // Store interval in ref so it doesn't cause re-subscriptions
  const intervalRef = useRef(intervalMs);

  useEffect(() => {
    // Subscribe returns the unsubscribe function
    const unsubscribe = subscribe(intervalRef.current);
    return unsubscribe;
  }, [subscribe]);
}

/**
 * Hook for enabling real-time SSE updates on perp markets.
 *
 * Subscribes to perp trade events and price updates to update the store
 * in real-time when trades occur. Complements polling for immediate feedback.
 *
 * @example
 * ```tsx
 * function MarketsPage() {
 *   usePerpMarketsRealtime(); // Enable real-time updates
 *   const { markets } = usePerpMarkets();
 *   // markets will update in real-time when trades occur
 * }
 * ```
 */
export function usePerpMarketsRealtime() {
  const updateMarketStats = usePerpMarketsStore(
    (state) => state.updateMarketStats,
  );

  // Handle trade events (OI and volume updates)
  const handleTrade = useCallback(
    (event: PerpTradeSSE) => {
      updateMarketStats(event.ticker, {
        openInterest: event.openInterest,
        volume24h: event.volume24h,
      });
    },
    [updateMarketStats],
  );

  usePerpMarketsSubscription({ onTrade: handleTrade });

  // Handle price update events
  usePerpPriceSubscription({
    onPriceUpdate: useCallback(
      (update: PerpPriceUpdateSSE) => {
        updateMarketStats(update.ticker, {
          currentPrice: update.newPrice ?? update.price,
          changePercent24h: update.changePercent,
        });
      },
      [updateMarketStats],
    ),
  });
}

/**
 * Get a specific market by ticker (memoized)
 *
 * @returns market - The market object if found
 * @returns loading - True while fetching
 * @returns error - Error message if fetch failed
 * @returns refetch - Function to force refetch
 * @returns initialLoadComplete - True once the first fetch has completed
 */
export function usePerpMarket(ticker: string) {
  const { markets, loading, error, refetch } = usePerpMarkets();
  const lastFetchedAt = usePerpMarketsStore((state) => state.lastFetchedAt);

  const market = useMemo(
    () => markets.find((m) => m.ticker.toLowerCase() === ticker.toLowerCase()),
    [markets, ticker],
  );

  // Initial load is complete when we've fetched at least once
  const initialLoadComplete = lastFetchedAt !== null;

  return { market, loading, error, refetch, initialLoadComplete };
}

/**
 * Get top movers (gainers and losers) - memoized
 */
export function usePerpTopMovers(count = 4) {
  const { markets, loading, error, refetch } = usePerpMarkets();

  const { topGainers, topLosers } = useMemo(() => {
    const sorted = [...markets].sort(
      (a, b) => b.changePercent24h - a.changePercent24h,
    );
    return {
      topGainers: sorted.slice(0, count),
      topLosers: sorted.slice(-count).reverse(),
    };
  }, [markets, count]);

  return { topGainers, topLosers, loading, error, refetch };
}

/**
 * Invalidate the markets cache.
 * Call after actions that affect market stats (trading, etc.)
 */
export function invalidatePerpMarketsCache() {
  usePerpMarketsStore.getState().invalidateCache();
}
