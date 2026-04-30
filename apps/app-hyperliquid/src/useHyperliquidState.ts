import { client } from "@elizaos/app-core";
import { useCallback, useEffect, useState } from "react";
import "./client";
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextStatus = await client.hyperliquidStatus();
      setStatus(nextStatus);

      if (!nextStatus.publicReadReady) {
        setMarkets(null);
        setPositions(null);
        setOrders(null);
        return;
      }

      const [nextMarkets, nextPositions, nextOrders] = await Promise.all([
        client.hyperliquidMarkets(),
        client.hyperliquidPositions(),
        client.hyperliquidOrders(),
      ]);
      setMarkets(nextMarkets);
      setPositions(nextPositions);
      setOrders(nextOrders);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Hyperliquid refresh failed",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    status,
    markets,
    positions,
    orders,
    loading,
    error,
    refresh,
  };
}
