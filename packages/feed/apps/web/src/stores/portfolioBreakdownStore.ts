import {
  type PortfolioBreakdownSnapshot,
  toNumber,
} from '@babylon/engine/client';
import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

interface PortfolioBreakdownState {
  data: PortfolioBreakdownSnapshot | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  userId: string | null;
  fetchPromise: Promise<void> | null;
  pollingInterval: ReturnType<typeof setInterval> | null;
  subscriberCount: number;
  fetchPortfolioBreakdown: (userId: string, force?: boolean) => Promise<void>;
  invalidate: () => void;
  reset: () => void;
  setUserId: (userId: string | null) => void;
  subscribe: (userId: string, intervalMs: number) => () => void;
}

const CACHE_TTL = 5000;

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  return false;
}

export async function fetchPortfolioBreakdownSnapshot(
  userId: string,
  signal: AbortSignal
): Promise<PortfolioBreakdownSnapshot> {
  let breakdownRes: Response;
  try {
    breakdownRes = await fetch(
      `/api/users/${encodeURIComponent(userId)}/portfolio-breakdown`,
      { signal }
    );
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw error;
    }
    throw new Error('Failed to fetch portfolio breakdown');
  }

  if (!breakdownRes.ok) {
    throw new Error('Failed to fetch portfolio breakdown');
  }

  let breakdownJson: Record<string, unknown>;
  try {
    breakdownJson = (await breakdownRes.json()) as Record<string, unknown>;
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw error;
    }
    throw new Error('Failed to parse portfolio breakdown');
  }

  return {
    wallet: toNumber(breakdownJson.wallet),
    agents: toNumber(breakdownJson.agents),
    positions: toNumber(breakdownJson.positions),
    available: toNumber(breakdownJson.available),
    netPeerTransfers: toNumber(breakdownJson.netPeerTransfers),
    originalAmount: toNumber(breakdownJson.originalAmount),
    totalAssets: toNumber(breakdownJson.totalAssets),
    totalPnL: toNumber(breakdownJson.totalPnL),
    agentCount: toNumber(breakdownJson.agentCount),
    members: Array.isArray(breakdownJson.members)
      ? breakdownJson.members
          .filter(
            (member): member is Record<string, unknown> =>
              typeof member === 'object' && member !== null
          )
          .map((member) => ({
            id: String(member.id ?? ''),
            name: String(member.name ?? 'Agent'),
            wallet: toNumber(member.wallet),
            isAgent: Boolean(member.isAgent),
          }))
      : [],
  };
}

export const usePortfolioBreakdownStore = create<PortfolioBreakdownState>(
  (set, get) => ({
    data: null,
    loading: false,
    error: null,
    lastFetchedAt: null,
    userId: null,
    fetchPromise: null,
    pollingInterval: null,
    subscriberCount: 0,

    fetchPortfolioBreakdown: async (userId: string, force = false) => {
      const state = get();

      if (state.fetchPromise && state.userId === userId) {
        return state.fetchPromise;
      }

      if (state.fetchPromise && state.userId !== userId) {
        await state.fetchPromise;
      }

      const currentState = get();

      if (
        !force &&
        currentState.userId === userId &&
        currentState.lastFetchedAt &&
        Date.now() - currentState.lastFetchedAt < CACHE_TTL &&
        currentState.data
      ) {
        return;
      }

      const requestedUserId = userId;

      const fetchPromise = (async () => {
        const isInitialLoad =
          currentState.lastFetchedAt === null ||
          currentState.userId !== requestedUserId;
        if (isInitialLoad) {
          set({ loading: true });
        }
        set({ error: null, userId: requestedUserId });

        const abortController = new AbortController();

        try {
          const nextData = await fetchPortfolioBreakdownSnapshot(
            requestedUserId,
            abortController.signal
          );

          if (get().userId !== requestedUserId) {
            return;
          }

          set({
            data: nextData,
            lastFetchedAt: Date.now(),
            error: null,
          });
        } catch (error) {
          if (get().userId === requestedUserId && !isAbortError(error)) {
            set({
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch portfolio breakdown',
            });
          }
        } finally {
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
        if (state.pollingInterval) {
          clearInterval(state.pollingInterval);
        }
        set({
          data: null,
          error: null,
          lastFetchedAt: null,
          userId,
          fetchPromise: null,
          pollingInterval: null,
          subscriberCount: 0,
        });
      }
    },

    invalidate: () => {
      set({ lastFetchedAt: null });
    },

    reset: () => {
      const state = get();
      if (state.pollingInterval) {
        clearInterval(state.pollingInterval);
      }
      set({
        data: null,
        loading: false,
        error: null,
        lastFetchedAt: null,
        userId: null,
        fetchPromise: null,
        pollingInterval: null,
        subscriberCount: 0,
      });
    },

    subscribe: (userId: string, intervalMs: number) => {
      const state = get();

      if (state.pollingInterval && state.userId !== userId) {
        clearInterval(state.pollingInterval);
        set({ pollingInterval: null, subscriberCount: 0, userId });
      }

      const newCount = state.subscriberCount + 1;
      set({ subscriberCount: newCount, userId });

      if (newCount === 1) {
        get().fetchPortfolioBreakdown(userId);

        const interval = setInterval(() => {
          const currentState = get();
          if (currentState.userId === userId) {
            currentState.fetchPortfolioBreakdown(userId, true);
          }
        }, intervalMs);

        set({ pollingInterval: interval });
      }

      return () => {
        const currentState = get();
        // Stale cleanup from a previous userId — ignore to avoid
        // decrementing the new userId's subscriber count.
        if (currentState.userId !== userId) return;

        const updatedCount = currentState.subscriberCount - 1;
        set({ subscriberCount: updatedCount });

        if (updatedCount === 0 && currentState.pollingInterval) {
          clearInterval(currentState.pollingInterval);
          set({ pollingInterval: null });
        }
      };
    },
  })
);

const portfolioBreakdownSelector = (state: PortfolioBreakdownState) => ({
  data: state.data,
  loading: state.loading,
  error: state.error,
  lastUpdated: state.lastFetchedAt,
});

export function usePortfolioBreakdown(userId?: string | null) {
  const data = usePortfolioBreakdownStore(
    useShallow(portfolioBreakdownSelector)
  );
  const fetchPortfolioBreakdown = usePortfolioBreakdownStore(
    (state) => state.fetchPortfolioBreakdown
  );
  const setUserId = usePortfolioBreakdownStore((state) => state.setUserId);

  useEffect(() => {
    if (userId) {
      setUserId(userId);
      fetchPortfolioBreakdown(userId);
    }
  }, [userId, fetchPortfolioBreakdown, setUserId]);

  const refresh = useCallback(() => {
    if (userId) {
      return fetchPortfolioBreakdown(userId, true);
    }
    return Promise.resolve();
  }, [userId, fetchPortfolioBreakdown]);

  return { ...data, refresh };
}

export function usePortfolioBreakdownPolling(
  userId?: string | null,
  intervalMs = 15000
) {
  const subscribe = usePortfolioBreakdownStore((state) => state.subscribe);
  const intervalRef = useRef(intervalMs);

  useEffect(() => {
    if (!userId) return;

    const unsubscribe = subscribe(userId, intervalRef.current);
    return unsubscribe;
  }, [userId, subscribe]);
}

export function invalidatePortfolioBreakdown() {
  usePortfolioBreakdownStore.getState().invalidate();
}

export async function refreshPortfolioBreakdown(userId: string) {
  return usePortfolioBreakdownStore
    .getState()
    .fetchPortfolioBreakdown(userId, true);
}
