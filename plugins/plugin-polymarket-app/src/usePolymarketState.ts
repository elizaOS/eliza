import { client } from "@elizaos/app-core";
import { useCallback, useEffect, useState } from "react";
import "./client";
import type {
  PolymarketMarket,
  PolymarketStatusResponse,
} from "./polymarket-contracts";

export function usePolymarketState() {
  const [status, setStatus] = useState<PolymarketStatusResponse | null>(null);
  const [markets, setMarkets] = useState<readonly PolymarketMarket[]>([]);
  const [selectedMarket, setSelectedMarket] = useState<PolymarketMarket | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusResponse, marketsResponse] = await Promise.all([
        client.polymarketStatus(),
        client.polymarketMarkets({ limit: 25 }),
      ]);
      setStatus(statusResponse);
      setMarkets(marketsResponse.markets);
      setSelectedMarket(marketsResponse.markets[0] ?? null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Polymarket refresh failed",
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
    selectedMarket,
    setSelectedMarket,
    loading,
    error,
    refresh,
  };
}
