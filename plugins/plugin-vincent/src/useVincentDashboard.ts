/**
 * useVincentDashboard — aggregated data hook for the Vincent overlay app.
 *
 * Polls Vincent-specific endpoints every 15 s when connected, and fetches
 * the agent wallet addresses and balances for dashboard context.
 */

import type { WalletAddresses, WalletBalancesResponse } from "@elizaos/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { vincentClient } from "./client";
import type {
  VincentStrategy,
  VincentTradingProfile,
} from "./vincent-contracts";

export interface VincentDashboardState {
  vincentConnected: boolean;
  vincentConnectedAt: number | null;

  walletAddresses: WalletAddresses | null;
  walletBalances: WalletBalancesResponse | null;

  strategy: VincentStrategy | null;

  tradingProfile: VincentTradingProfile | null;

  loading: boolean;
  error: string | null;

  refresh: () => void;
}

const POLL_INTERVAL_MS = 15_000;

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
      const vincentStatusResult = await vincentClient.vincentStatus();
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
        vincentClient.getWalletAddresses(),
        vincentClient.getWalletBalances(),
        vincentClient.vincentStrategy(),
        vincentClient.vincentTradingProfile(),
      ]);

      if (!mountedRef.current) return;

      if (addressResult.status === "fulfilled") {
        setWalletAddresses(addressResult.value);
      }
      if (balanceResult.status === "fulfilled") {
        setWalletBalances(balanceResult.value);
      }
      if (strategyResult.status === "fulfilled") {
        setStrategy(strategyResult.value.strategy);
      }
      if (tradingProfileResult.status === "fulfilled") {
        setTradingProfile(tradingProfileResult.value.profile);
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
