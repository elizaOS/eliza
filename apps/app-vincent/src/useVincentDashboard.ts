/**
 * useVincentDashboard — aggregated data hook for the Vincent overlay app.
 *
 * Polls Vincent-specific endpoints every 15 s when connected, and fetches
 * the agent's internal wallet addresses + balances (not steward — steward
 * is a separate optional vault layer).
 */

import type {
  WalletAddresses,
  WalletBalancesResponse,
} from "@elizaos/shared/contracts/wallet";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "@elizaos/app-core";

// ── Vincent endpoint types ──────────────────────────────────────────────

export interface VincentStrategy {
  name: "dca" | "rebalance" | "threshold" | "manual" | null;
  params: Record<string, unknown>;
  intervalSeconds: number;
  dryRun: boolean;
  running: boolean;
}

export interface VincentTradingProfile {
  totalPnl: string;
  winRate: number;
  totalSwaps: number;
  volume24h: string;
  tokenBreakdown: Array<{ symbol: string; pnl: string; swaps: number }>;
}

// ── Hook state shape ──────────────────────────────────────────────────────

export interface VincentDashboardState {
  // Vincent OAuth status
  vincentConnected: boolean;
  vincentConnectedAt: number | null;

  // Internal agent wallet (addresses + balances)
  walletAddresses: WalletAddresses | null;
  walletBalances: WalletBalancesResponse | null;

  // Current strategy config (GET /api/vincent/strategy)
  strategy: VincentStrategy | null;

  // P&L analytics (GET /api/vincent/trading-profile)
  tradingProfile: VincentTradingProfile | null;

  // Loading + error state
  loading: boolean;
  error: string | null;

  // Manual refresh
  refresh: () => void;
}

const POLL_INTERVAL_MS = 15_000;

async function fetchOrNull<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function useVincentDashboard(): VincentDashboardState {
  const [vincentConnected, setVincentConnected] = useState(false);
  const [vincentConnectedAt, setVincentConnectedAt] = useState<number | null>(
    null,
  );
  const [walletAddresses, setWalletAddresses] =
    useState<WalletAddresses | null>(null);
  const [walletBalances, setWalletBalances] =
    useState<WalletBalancesResponse | null>(null);
  const [strategy, setStrategy] = useState<VincentStrategy | null>(null);
  const [tradingProfile, setTradingProfile] =
    useState<VincentTradingProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const fetchAll = useCallback(async () => {
    try {
      // Always check Vincent OAuth status first
      const vincentStatusResult = await client.vincentStatus();
      if (!mountedRef.current) return;
      setVincentConnected(vincentStatusResult.connected);
      setVincentConnectedAt(vincentStatusResult.connectedAt);

      // Fetch internal wallet + Vincent data in parallel
      const [
        addressResult,
        balanceResult,
        strategyResult,
        tradingProfileResult,
      ] = await Promise.allSettled([
        client.getWalletAddresses(),
        client.getWalletBalances(),
        fetchOrNull<VincentStrategy>("/api/vincent/strategy"),
        fetchOrNull<VincentTradingProfile>("/api/vincent/trading-profile"),
      ]);

      if (!mountedRef.current) return;

      if (addressResult.status === "fulfilled") {
        setWalletAddresses(addressResult.value);
      }
      if (balanceResult.status === "fulfilled") {
        setWalletBalances(balanceResult.value);
      }
      if (strategyResult.status === "fulfilled" && strategyResult.value) {
        // API wraps in { connected, strategy: {...} }
        const raw = strategyResult.value as
          | VincentStrategy
          | { strategy: VincentStrategy };
        setStrategy(
          "strategy" in raw && raw.strategy
            ? raw.strategy
            : (raw as VincentStrategy),
        );
      }
      if (
        tradingProfileResult.status === "fulfilled" &&
        tradingProfileResult.value
      ) {
        // API wraps in { connected, profile: {...} }
        const raw = tradingProfileResult.value as
          | VincentTradingProfile
          | { profile: VincentTradingProfile };
        setTradingProfile(
          "profile" in raw && raw.profile
            ? raw.profile
            : (raw as VincentTradingProfile),
        );
      }

      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    mountedRef.current = true;
    void fetchAll();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchAll]);

  // Start polling when connected, stop when disconnected
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (vincentConnected) {
      intervalRef.current = setInterval(
        () => void fetchAll(),
        POLL_INTERVAL_MS,
      );
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [vincentConnected, fetchAll]);

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchAll();
  }, [fetchAll]);

  return {
    vincentConnected,
    vincentConnectedAt,
    walletAddresses,
    walletBalances,
    strategy,
    tradingProfile,
    loading,
    error,
    refresh,
  };
}
