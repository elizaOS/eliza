/**
 * React hook backing the Hyperliquid view: fetches status, markets,
 * positions, and orders from the four read routes, polls every 15s, and
 * exposes loading/error/unavailable state plus a manual `refresh()`.
 */
import { client } from "@elizaos/app-core";
import { ApiError } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import "./client";
import type { HyperliquidClient } from "./client";
import type {
  HyperliquidMarketsResponse,
  HyperliquidOrdersResponse,
  HyperliquidPositionsResponse,
  HyperliquidStatusResponse,
} from "./hyperliquid-contracts";

export interface HyperliquidState {
  status: HyperliquidStatusResponse | null;
  markets: HyperliquidMarketsResponse | null;
  positions: HyperliquidPositionsResponse | null;
  orders: HyperliquidOrdersResponse | null;
  loading: boolean;
  error: string | null;
  /**
   * True when the Hyperliquid app routes are not mounted on this surface (the
   * read endpoints 404/503) — e.g. the mobile bundle that ships without the
   * app-route plugin. The view degrades to a clean "unavailable" state instead
   * of surfacing the raw fetch error.
   */
  unavailable: boolean;
  refresh: () => Promise<void>;
}

export function useHyperliquidState(): HyperliquidState {
  const [status, setStatus] = useState<HyperliquidStatusResponse | null>(null);
  const [markets, setMarkets] = useState<HyperliquidMarketsResponse | null>(
    null,
  );
  const [positions, setPositions] =
    useState<HyperliquidPositionsResponse | null>(null);
  const [orders, setOrders] = useState<HyperliquidOrdersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnavailable(false);
    const hyperliquidClient = client as HyperliquidClient;
    try {
      const nextStatus = await hyperliquidClient.hyperliquidStatus();
      setStatus(nextStatus);

      if (!nextStatus.publicReadReady) {
        setMarkets(null);
        setPositions(null);
        setOrders(null);
        return;
      }

      const [nextMarkets, nextPositions, nextOrders] = await Promise.all([
        hyperliquidClient.hyperliquidMarkets(),
        hyperliquidClient.hyperliquidPositions(),
        hyperliquidClient.hyperliquidOrders(),
      ]);
      setMarkets(nextMarkets);
      setPositions(nextPositions);
      setOrders(nextOrders);
    } catch (caught) {
      // The Hyperliquid app routes only mount where the app-route plugin is
      // loaded. On surfaces that ship without it (e.g. the mobile bundle) the
      // read endpoints 404, or 503 while the agent is still booting — neither is
      // a real failure, so degrade to a clean "unavailable" state rather than
      // surfacing the raw fetch error.
      if (
        caught instanceof ApiError &&
        (caught.status === 404 || caught.status === 503)
      ) {
        setStatus(null);
        setMarkets(null);
        setPositions(null);
        setOrders(null);
        setUnavailable(true);
        return;
      }
      setError(
        caught instanceof Error ? caught.message : "Hyperliquid refresh failed",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 15000);
    return () => clearInterval(interval);
  }, [refresh]);

  return {
    status,
    markets,
    positions,
    orders,
    loading,
    error,
    unavailable,
    refresh,
  };
}
