/**
 * HyperliquidView — the single GUI/XR data wrapper for the Hyperliquid surface.
 *
 * It owns the live data (status + markets + the agent's own positions + open
 * orders, plus a background poll via {@link useHyperliquidState}) and renders
 * the one presentational {@link HyperliquidSpatialView} inside a
 * {@link SpatialSurface}. Omitting the `modality` prop lets `SpatialSurface`
 * auto-detect GUI vs XR via `window.__elizaXRContext`, so the SAME component
 * serves both surfaces. The TUI surface renders the same
 * `HyperliquidSpatialView` through the terminal registry (see
 * `register-terminal-view.tsx`).
 */

import { useCallback } from "react";
import {
  type HyperliquidSnapshot,
  HyperliquidSpatialView,
} from "./components/HyperliquidSpatialView.tsx";
import { useHyperliquidState } from "./useHyperliquidState.ts";

/** Return to the apps/home surface via the navigation bus. */
function navigateHome(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("eliza:navigate:view", {
      detail: { viewId: "home", viewPath: "/" },
    }),
  );
}

export function HyperliquidView() {
  const {
    status,
    markets,
    positions,
    orders,
    loading,
    error,
    unavailable,
    refresh,
  } = useHyperliquidState();

  const onAction = useCallback(
    (action: string) => {
      switch (action) {
        case "refresh":
          void refresh();
          return;
        case "back":
          navigateHome();
          return;
      }
    },
    [refresh],
  );

  const snapshot: HyperliquidSnapshot = {
    status: {
      publicReadReady: status?.publicReadReady ?? false,
      signerReady: status?.signerReady ?? false,
      executionReady: status?.executionReady ?? false,
      credentialMode: status?.credentialMode ?? "none",
      accountAddress: status?.account.address ?? null,
      vaultReady: status?.vault.ready ?? false,
      executionBlockedReason: status?.executionBlockedReason ?? null,
      vaultGuidance: status?.vault.guidance ?? null,
    },
    markets: markets?.markets ?? [],
    positions: positions?.positions ?? [],
    summary: positions?.summary ?? null,
    orders: orders?.orders ?? [],
    positionsBlockedReason: positions?.readBlockedReason ?? null,
    ordersBlockedReason: orders?.readBlockedReason ?? null,
    unavailable,
    loading,
    error,
  };

  return <HyperliquidSpatialView snapshot={snapshot} onAction={onAction} />;
}
