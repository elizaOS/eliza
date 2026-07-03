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

import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Button } from "@elizaos/ui/components/ui/button";
import { dispatchNavigateViewEvent } from "@elizaos/ui/events";
import { type CSSProperties, useCallback } from "react";
import {
  type HyperliquidSnapshot,
  HyperliquidSpatialView,
} from "./components/HyperliquidSpatialView.tsx";
import { useHyperliquidState } from "./useHyperliquidState.ts";

/** Return to the apps/home surface via the navigation bus. */
function navigateHome(): void {
  if (typeof window === "undefined") return;
  dispatchNavigateViewEvent({ viewId: "home", viewPath: "/" });
}

const AGENT_TOOLBAR_STYLE: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "center",
  flexWrap: "wrap",
  padding: "0.4rem 0.5rem",
};

const AGENT_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0.4rem 0.85rem",
  borderRadius: "0.4rem",
  border: "1px solid var(--primary, #d2691e)",
  background: "var(--primary, #d2691e)",
  color: "var(--primary-foreground, #fff)",
  fontWeight: 600,
  fontSize: "0.85rem",
  cursor: "pointer",
};

const AGENT_BUTTON_OUTLINE_STYLE: CSSProperties = {
  ...AGENT_BUTTON_STYLE,
  background: "transparent",
  color: "var(--primary, #d2691e)",
};

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

  // The spatial primitives below carry only inert `data-agent-*` markers, so
  // the GUI/XR wrapper registers the view's primary actions with the live
  // agent-surface registry here, reusing the same handlers the spatial view
  // dispatches through `onAction`.
  const refreshControl = useAgentElement<HTMLButtonElement>({
    id: "hyperliquid-refresh",
    role: "button",
    label: "Refresh Hyperliquid",
    group: "hyperliquid",
    description: "Reload Hyperliquid status, markets, positions, and orders",
    status: loading ? "loading" : undefined,
    onActivate: () => {
      void refresh();
    },
  });
  const homeControl = useAgentElement<HTMLButtonElement>({
    id: "hyperliquid-home",
    role: "button",
    label: "Back to home",
    group: "hyperliquid",
    description: "Leave Hyperliquid and return to the home surface",
    onActivate: navigateHome,
  });

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

  return (
    <>
      <div
        role="toolbar"
        aria-label="Hyperliquid controls"
        style={AGENT_TOOLBAR_STYLE}
      >
        <Button
          unstyled
          ref={refreshControl.ref}
          {...refreshControl.agentProps}
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          style={{
            ...AGENT_BUTTON_STYLE,
            opacity: loading ? 0.6 : 1,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
        <Button
          unstyled
          ref={homeControl.ref}
          {...homeControl.agentProps}
          type="button"
          onClick={navigateHome}
          style={AGENT_BUTTON_OUTLINE_STYLE}
        >
          Home
        </Button>
      </div>
      <HyperliquidSpatialView snapshot={snapshot} onAction={onAction} />
    </>
  );
}
