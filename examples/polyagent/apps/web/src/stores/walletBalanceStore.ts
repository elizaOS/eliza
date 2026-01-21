/**
 * Wallet Balance Store - Centralized state management for user wallet balance
 *
 * This store prevents duplicate API calls and flickering by:
 * 1. Caching balance data globally
 * 2. Only showing loading on initial fetch (not background refreshes)
 * 3. Deduplicating concurrent requests
 * 4. Single polling mechanism shared across components
 *
 * Usage:
 * ```tsx
 * import { useWalletBalanceStore, useWalletBalancePolling } from '@/stores/walletBalanceStore';
 *
 * function MyComponent() {
 *   const { balance, lifetimePnL, loading } = useWalletBalanceStore();
 *   useWalletBalancePolling(userId); // Enable polling for this user
 *   return <div>Balance: ${balance}</div>;
 * }
 * ```
 */

import { useCallback, useEffect, useRef } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

interface WalletBalanceState {
  // Data
  balance: number;
  lifetimePnL: number;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  userId: string | null;

  // Internal state
  fetchPromise: Promise<void> | null;

  // Actions
  fetchBalance: (userId: string, force?: boolean) => Promise<void>;
  setUserId: (userId: string | null) => void;
  invalidate: () => void;
  reset: () => void;
}

// Cache TTL: 5 seconds (balance can change frequently during trading)
const CACHE_TTL = 5000;

export const useWalletBalanceStore = create<WalletBalanceState>((set, get) => ({
  balance: 0,
  lifetimePnL: 0,
  loading: false,
  error: null,
  lastFetchedAt: null,
  userId: null,
  fetchPromise: null,

  fetchBalance: async (userId: string, force = false) => {
    const state = get();

    // Return existing promise if already fetching for the SAME user (deduplication)
    if (state.fetchPromise && state.userId === userId) {
      return state.fetchPromise;
    }

    // If fetching for a different user, wait for current fetch to complete first
    if (state.fetchPromise && state.userId !== userId) {
      await state.fetchPromise;
    }

    // Re-fetch fresh state after await to avoid stale cache checks
    const currentState = get();

    // Return cached data if fresh and not forced
    if (
      !force &&
      currentState.userId === userId &&
      currentState.lastFetchedAt &&
      Date.now() - currentState.lastFetchedAt < CACHE_TTL
    ) {
      return;
    }

    // Capture the requested userId to prevent cross-user data leakage
    const requestedUserId = userId;

    // Create and store the fetch promise
    const fetchPromise = (async () => {
      // Only show loading on initial fetch (no cached data yet)
      const isInitialLoad =
        currentState.lastFetchedAt === null ||
        currentState.userId !== requestedUserId;
      if (isInitialLoad) {
        set({ loading: true });
      }
      set({ error: null, userId: requestedUserId });

      try {
        const response = await fetch(
          `/api/users/${encodeURIComponent(requestedUserId)}/balance`,
        );

        if (!response.ok) {
          throw new Error(`Failed to fetch balance: ${response.status}`);
        }

        const data = await response.json();

        // Verify user hasn't changed during fetch to prevent data leakage
        if (get().userId !== requestedUserId) {
          // User changed during fetch - discard stale response
          return;
        }

        set({
          balance: Number(data.balance) || 0,
          lifetimePnL: Number(data.lifetimePnL) || 0,
          lastFetchedAt: Date.now(),
          error: null,
        });
      } catch (err) {
        // Only set error if user hasn't changed
        if (get().userId === requestedUserId) {
          const errorMessage =
            err instanceof Error ? err.message : "Failed to fetch balance";
          set({ error: errorMessage });
        }
      } finally {
        // Only clear loading/promise if this fetch is still relevant
        if (get().userId === requestedUserId) {
          set({ loading: false, fetchPromise: null });
        }
      }
    })();

    set({ fetchPromise });
    return fetchPromise;
  },

  setUserId: (userId: string | null) => {
    const state = get();
    if (state.userId !== userId) {
      // Clear cache, error, and any in-flight fetch when user changes
      // This prevents cross-user data leakage from stale fetch responses
      set({
        userId,
        lastFetchedAt: null,
        balance: 0,
        lifetimePnL: 0,
        error: null,
        fetchPromise: null,
      });
    }
  },

  invalidate: () => {
    set({ lastFetchedAt: null });
  },

  reset: () => {
    set({
      balance: 0,
      lifetimePnL: 0,
      loading: false,
      error: null,
      lastFetchedAt: null,
      userId: null,
      fetchPromise: null,
    });
  },
}));

// Selector for balance data
const balanceSelector = (state: WalletBalanceState) => ({
  balance: state.balance,
  lifetimePnL: state.lifetimePnL,
  loading: state.loading,
  error: state.error,
});

/**
 * Hook for consuming wallet balance data.
 * Use with useWalletBalancePolling to enable automatic updates.
 */
export function useWalletBalance(userId?: string | null) {
  const { balance, lifetimePnL, loading, error } = useWalletBalanceStore(
    useShallow(balanceSelector),
  );
  const fetchBalance = useWalletBalanceStore((state) => state.fetchBalance);
  const setUserId = useWalletBalanceStore((state) => state.setUserId);

  // Fetch on mount if userId provided
  useEffect(() => {
    if (userId) {
      setUserId(userId);
      fetchBalance(userId);
    }
  }, [userId, fetchBalance, setUserId]);

  const refresh = useCallback(() => {
    if (userId) {
      return fetchBalance(userId, true);
    }
    return Promise.resolve();
  }, [userId, fetchBalance]);

  return { balance, lifetimePnL, loading, error, refresh };
}

/**
 * Hook for enabling wallet balance polling.
 * Automatically fetches balance every 15 seconds when active.
 *
 * @param userId - The user ID to poll balance for
 * @param intervalMs - Polling interval in milliseconds (default: 15000)
 */
export function useWalletBalancePolling(
  userId?: string | null,
  intervalMs = 15000,
) {
  const fetchBalance = useWalletBalanceStore((state) => state.fetchBalance);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!userId) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Initial fetch
    fetchBalance(userId);

    // Set up polling
    intervalRef.current = setInterval(() => {
      fetchBalance(userId, true);
    }, intervalMs);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [userId, intervalMs, fetchBalance]);
}

/**
 * Invalidate the balance cache.
 * Call after actions that affect balance (trading, etc.)
 */
export function invalidateWalletBalance() {
  useWalletBalanceStore.getState().invalidate();
}

/**
 * Force refresh the balance.
 * Returns a promise that resolves when the refresh is complete.
 */
export async function refreshWalletBalance(userId: string) {
  return useWalletBalanceStore.getState().fetchBalance(userId, true);
}
