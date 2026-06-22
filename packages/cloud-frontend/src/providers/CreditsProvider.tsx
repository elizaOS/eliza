"use client";

/**
 * Credits Provider - single source of truth for the org credit balance.
 *
 * Backed by the `useCreditsBalance()` TanStack hook (`lib/data/credits.ts`) so
 * the balance is fetched through ONE cache shared with every other
 * `useCreditsBalance()` consumer: no duplicate poll, no second source of
 * truth. The context exists only to share that one query instance and expose
 * the stable `useCredits()` API (creditBalance/isConnected/isLoading/error/
 * lastUpdate/refreshBalance). Background tabs refresh the moment they become
 * visible again, so each tab always shows a fresh balance without a cross-tab
 * broadcast loop.
 */

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useCreditsBalance } from "@/lib/data/credits";

interface CreditsContextValue {
  creditBalance: number | null;
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  lastUpdate: Date | null;
  refreshBalance: () => Promise<void>;
}

const CreditsContext = createContext<CreditsContextValue | null>(null);

const POLL_INTERVAL = 30_000;

export function CreditsProvider({ children }: { children: ReactNode }) {
  const query = useCreditsBalance();
  const { data, isLoading, isError, error, dataUpdatedAt, refetch } = query;

  const creditBalance = data ? data.balance : null;

  const refreshBalance = useMemo(
    () => async () => {
      await refetch();
    },
    [refetch],
  );

  // Visibility-gated 30s refresh. TanStack dedupes onto the single
  // `useCreditsBalance` cache, so this never opens a second fetch path.
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        void refetchRef.current();
      }
    }, POLL_INTERVAL);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refetchRef.current();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const value = useMemo<CreditsContextValue>(
    () => ({
      creditBalance,
      isConnected: !isError,
      isLoading,
      error: isError
        ? error instanceof Error
          ? error.message
          : "Failed to fetch balance"
        : null,
      lastUpdate: dataUpdatedAt ? new Date(dataUpdatedAt) : null,
      refreshBalance,
    }),
    [creditBalance, isError, isLoading, error, dataUpdatedAt, refreshBalance],
  );

  return (
    <CreditsContext.Provider value={value}>{children}</CreditsContext.Provider>
  );
}

/**
 * Hook to consume credits context. Falls back to a sensible default when used
 * outside the provider so consumers can be mounted during gradual migration.
 */
export function useCredits(): CreditsContextValue {
  const context = useContext(CreditsContext);

  if (!context) {
    return {
      creditBalance: null,
      isConnected: false,
      isLoading: true,
      error: null,
      lastUpdate: null,
      refreshBalance: async () => {},
    };
  }

  return context;
}
