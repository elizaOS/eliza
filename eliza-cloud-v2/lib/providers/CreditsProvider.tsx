"use client";

/**
 * Credits Provider - Centralized credit balance management
 *
 * Solves the duplicate polling problem by providing a single source of truth
 * for credit balance across all components that need it.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
  type ReactNode,
} from "react";
import { usePrivy } from "@privy-io/react-auth";
import { logger } from "@/lib/utils/logger";

interface CreditsContextValue {
  creditBalance: number | null;
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  lastUpdate: Date | null;
  refreshBalance: () => Promise<void>;
}

const CreditsContext = createContext<CreditsContextValue | null>(null);

const POLL_INTERVAL = 30000; // Increased from 10s to 30s
const MAX_AUTH_ERRORS = 3;

export function CreditsProvider({ children }: { children: ReactNode }) {
  const { authenticated, ready, getAccessToken, logout } = usePrivy();
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [isConnected, setIsConnected] = useState(true);

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);
  const authErrorCountRef = useRef(0);
  const isPollingPausedRef = useRef(false);
  const isVisibleRef = useRef(true);
  const lastFetchTimeRef = useRef<number>(0);
  // Flag to prevent race conditions during logout - ensures no fetches fire during logout flow
  const isLoggingOutRef = useRef(false);

  // Store Privy functions in refs to avoid recreating callbacks on every render
  const getAccessTokenRef = useRef(getAccessToken);
  const logoutRef = useRef(logout);

  // Update refs in effect to avoid updating during render
  useEffect(() => {
    getAccessTokenRef.current = getAccessToken;
    logoutRef.current = logout;
  }, [getAccessToken, logout]);

  // Stop polling when too many auth errors occur
  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    isPollingPausedRef.current = true;
  }, []);

  // Resume polling (e.g., when user re-authenticates)
  const resumePolling = useCallback(() => {
    authErrorCountRef.current = 0;
    isPollingPausedRef.current = false;
    isLoggingOutRef.current = false; // Reset logout flag on re-authentication
  }, []);

  const fetchBalance = useCallback(async () => {
    if (!isMountedRef.current) return;

    // Don't fetch if logout is in progress - prevents race conditions
    if (isLoggingOutRef.current) return;

    // Don't fetch if not authenticated, polling is paused, or tab is hidden
    if (!authenticated || isPollingPausedRef.current || !isVisibleRef.current) {
      if (isMountedRef.current) {
        setIsLoading(false);
        if (!authenticated) {
          setCreditBalance(null);
          setError(null);
        }
      }
      return;
    }

    // Debounce: don't fetch more than once per 5 seconds
    const now = Date.now();
    if (now - lastFetchTimeRef.current < 5000) {
      return;
    }
    lastFetchTimeRef.current = now;

    // Note: credentials: "include" is required for cookie-based auth.
    // For cross-origin scenarios, the server must set cookies with SameSite=None; Secure
    const doFetch = () =>
      fetch("/api/credits/balance", {
        cache: "no-store",
        credentials: "include",
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
        },
      });

    let response = await doFetch();

    // On 401, try to refresh the session and retry once
    if (response.status === 401) {
      logger.info("[CreditsProvider] Session may be stale, refreshing...");

      // getAccessToken() triggers Privy to refresh the session/cookies
      const freshToken = await getAccessTokenRef.current().catch(() => null);

      if (!freshToken) {
        // Token refresh failed - session is truly expired
        logger.warn("[CreditsProvider] Session refresh failed, logging out");
        if (isMountedRef.current) {
          setError("Session expired");
          setIsConnected(false);
          setCreditBalance(null);
          setIsLoading(false);
        }
        // Set logout flag BEFORE stopping polling to prevent race conditions
        isLoggingOutRef.current = true;
        stopPolling();
        logoutRef.current();
        return;
      }

      // Token refresh succeeded - reset error counter before retry
      // This acknowledges the auth system is working, giving a fresh set of retries
      authErrorCountRef.current = 0;

      // Retry with refreshed session
      response = await doFetch();
    }

    if (!response.ok) {
      if (response.status === 401) {
        authErrorCountRef.current++;

        if (authErrorCountRef.current >= MAX_AUTH_ERRORS) {
          logger.warn(
            "[CreditsProvider] Too many auth errors after refresh, logging out",
          );
          // Set logout flag BEFORE stopping polling to prevent race conditions
          isLoggingOutRef.current = true;
          stopPolling();
          logoutRef.current();
          // Early return after triggering logout to prevent further processing
          if (isMountedRef.current) {
            setError("Unauthorized");
            setIsConnected(false);
            setCreditBalance(null);
            setIsLoading(false);
          }
          return;
        }

        if (isMountedRef.current) {
          setError("Unauthorized");
          setIsConnected(false);
          setCreditBalance(null);
          setIsLoading(false);
        }
        return;
      }

      throw new Error(`Failed to fetch balance: ${response.statusText}`);
    }

    authErrorCountRef.current = 0;

    const data = await response.json();
    const balance = Number(data.balance);

    if (isMountedRef.current) {
      setCreditBalance(balance);
      setLastUpdate(new Date());
      setIsConnected(true);
      setError(null);
      setIsLoading(false);

      broadcastChannelRef.current?.postMessage({
        type: "credit-update",
        balance,
        timestamp: new Date().toISOString(),
      });
    }
  }, [authenticated, stopPolling]);

  // Setup BroadcastChannel for cross-tab sync
  useEffect(() => {
    if (typeof window !== "undefined" && "BroadcastChannel" in window) {
      broadcastChannelRef.current = new BroadcastChannel("credits-sync");

      broadcastChannelRef.current.onmessage = (event) => {
        if (event.data.type === "credit-update" && isMountedRef.current) {
          setCreditBalance(event.data.balance);
          setLastUpdate(new Date(event.data.timestamp));
        }
      };

      return () => {
        broadcastChannelRef.current?.close();
      };
    }
  }, []);

  // Visibility change handler - pause polling when tab is hidden
  useEffect(() => {
    const handleVisibilityChange = () => {
      isVisibleRef.current = document.visibilityState === "visible";

      // Fetch immediately when tab becomes visible (if enough time has passed)
      if (isVisibleRef.current && authenticated && ready) {
        fetchBalance();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [authenticated, ready, fetchBalance]);

  // Reset and resume polling when authentication state changes
  useEffect(() => {
    if (ready && authenticated) {
      resumePolling();
    }
  }, [ready, authenticated, resumePolling]);

  // Main polling effect
  useEffect(() => {
    isMountedRef.current = true;

    if (ready && authenticated && !isPollingPausedRef.current) {
      // Defer initial fetch to avoid cascading renders
      queueMicrotask(() => {
        fetchBalance();
      });

      pollIntervalRef.current = setInterval(() => {
        if (isVisibleRef.current) {
          fetchBalance();
        }
      }, POLL_INTERVAL);
    } else if (ready && !authenticated) {
      // Use queueMicrotask to defer execution and avoid synchronous setState
      queueMicrotask(() => {
        setIsLoading(false);
        setCreditBalance(null);
      });
    }

    return () => {
      isMountedRef.current = false;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [ready, authenticated, fetchBalance]);

  const value = useMemo<CreditsContextValue>(
    () => ({
      creditBalance,
      isConnected,
      isLoading,
      error,
      lastUpdate,
      refreshBalance: fetchBalance,
    }),
    [creditBalance, isConnected, isLoading, error, lastUpdate, fetchBalance],
  );

  return (
    <CreditsContext.Provider value={value}>{children}</CreditsContext.Provider>
  );
}

/**
 * Hook to consume credits context
 * Falls back gracefully when used outside provider
 */
export function useCredits(): CreditsContextValue {
  const context = useContext(CreditsContext);

  if (!context) {
    // Return a sensible default when used outside provider
    // This allows gradual migration
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
