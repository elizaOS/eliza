/**
 * `usePolymarketState()` — the live-state React hook backing `PolymarketView`.
 * Fetches status + markets on mount/refresh, then conditionally fetches the
 * agent's own positions when an account address is resolvable.
 */
import { client } from "@elizaos/app-core";
import { useCallback, useEffect, useState } from "react";
import "./client";
import type { PolymarketClient } from "./client";
import type {
  PolymarketMarket,
  PolymarketPositionsResponse,
  PolymarketStatusResponse,
} from "./polymarket-contracts";

export function usePolymarketState() {
  const [status, setStatus] = useState<PolymarketStatusResponse | null>(null);
  const [markets, setMarkets] = useState<readonly PolymarketMarket[]>([]);
  const [selectedMarket, setSelectedMarket] = useState<PolymarketMarket | null>(
    null,
  );
  const [positions, setPositions] =
    useState<PolymarketPositionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const polymarketClient = client as PolymarketClient;
    try {
      const [statusResponse, marketsResponse] = await Promise.all([
        polymarketClient.polymarketStatus(),
        polymarketClient.polymarketMarkets({ limit: 25 }),
      ]);
      setStatus(statusResponse);
      setMarkets(marketsResponse.markets);
      setSelectedMarket(marketsResponse.markets[0] ?? null);

      // Read the agent's own positions only when an account address is
      // resolvable; the route falls back to the configured wallet so we call
      // it without an explicit `user`. A position-read failure must not blank
      // the whole view, so it's isolated from the markets fetch. The `account`
      // block is typed as required but partial/upstream status responses omit it
      // (#14448) — a missing account is simply "not resolvable", so guard the
      // access rather than let it throw a raw property-read into the view.
      if (statusResponse.account?.ready) {
        try {
          setPositions(await polymarketClient.polymarketPositions());
        } catch {
          setPositions(null);
        }
      } else {
        setPositions(null);
      }
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
    positions,
    loading,
    error,
    refresh,
  };
}
