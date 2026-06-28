/**
 * PolymarketView — the single GUI/XR data wrapper for the Polymarket surface.
 *
 * It owns the live data (status + markets + the agent's own positions, plus a
 * quiet background poll) and renders the one presentational
 * {@link PolymarketSpatialView} inside a {@link SpatialSurface}. Omitting the
 * `modality` prop lets `SpatialSurface` auto-detect GUI vs XR via
 * `window.__elizaXRContext`, so the SAME component serves both surfaces. The
 * TUI surface renders the same `PolymarketSpatialView` through the terminal
 * registry (see `register-terminal-view.tsx`).
 */

import { SpatialSurface } from "@elizaos/ui/spatial";
import { useCallback, useEffect } from "react";
import {
  type PolymarketSnapshot,
  PolymarketSpatialView,
} from "./components/PolymarketSpatialView.tsx";
import { usePolymarketState } from "./usePolymarketState.ts";

export function PolymarketView() {
  const {
    status,
    markets,
    selectedMarket,
    setSelectedMarket,
    positions,
    loading,
    error,
    refresh,
  } = usePolymarketState();

  // The view has no live subscription, so keep the market list fresh with a
  // quiet background poll. Torn down on unmount.
  useEffect(() => {
    const interval = setInterval(() => {
      void refresh();
    }, 20000);
    return () => clearInterval(interval);
  }, [refresh]);

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("market:")) {
        const id = action.slice("market:".length);
        const next = markets.find((market) => market.id === id) ?? null;
        setSelectedMarket(next);
        return;
      }
      switch (action) {
        case "detail-back":
          setSelectedMarket(null);
          return;
        case "refresh":
          void refresh();
          return;
      }
    },
    [markets, refresh, setSelectedMarket],
  );

  const snapshot: PolymarketSnapshot = {
    status,
    markets,
    selectedMarket,
    positions: positions?.positions ?? [],
    positionsSummary: positions?.summary ?? null,
    loading,
    error,
  };

  return (
    <SpatialSurface>
      <PolymarketSpatialView snapshot={snapshot} onAction={onAction} />
    </SpatialSurface>
  );
}
