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

import { useAgentElement } from "@elizaos/ui/agent-surface";
import { type CSSProperties, useCallback, useEffect } from "react";
import {
  type PolymarketSnapshot,
  PolymarketSpatialView,
} from "./components/PolymarketSpatialView.tsx";
import { usePolymarketState } from "./usePolymarketState.ts";

const AGENT_HIDDEN_CONTROL_STYLE: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

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

  // The spatial primitives below carry only inert `data-agent-*` markers, so the
  // GUI/XR wrapper registers the view's primary actions with the live
  // agent-surface registry here, reusing the same handlers `onAction` dispatches.
  const refreshControl = useAgentElement<HTMLButtonElement>({
    id: "polymarket-refresh",
    role: "button",
    label: "Refresh Polymarket",
    group: "polymarket",
    description: "Reload Polymarket status, markets, and positions",
    status: loading ? "loading" : undefined,
    onActivate: () => {
      void refresh();
    },
  });
  const backToMarketsControl = useAgentElement<HTMLButtonElement>({
    id: "polymarket-detail-back",
    role: "button",
    label: "Back to markets",
    group: "polymarket",
    description: "Close the open market detail and return to the market list",
    status: selectedMarket ? "active" : "inactive",
    onActivate: () => setSelectedMarket(null),
  });

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
    <>
      <div aria-hidden="true">
        <button
          ref={refreshControl.ref}
          {...refreshControl.agentProps}
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          tabIndex={-1}
          style={AGENT_HIDDEN_CONTROL_STYLE}
        />
        {selectedMarket ? (
          <button
            ref={backToMarketsControl.ref}
            {...backToMarketsControl.agentProps}
            type="button"
            onClick={() => setSelectedMarket(null)}
            tabIndex={-1}
            style={AGENT_HIDDEN_CONTROL_STYLE}
          />
        ) : null}
      </div>
      <PolymarketSpatialView snapshot={snapshot} onAction={onAction} />
    </>
  );
}
