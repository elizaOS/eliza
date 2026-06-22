/**
 * SwapView — the single GUI/XR data wrapper for the swap surface.
 *
 * It owns the live swap state (token-in/token-out selection, the amount + the
 * quote/execute lifecycle via {@link useSwapState}) and renders the one
 * presentational {@link SwapSpatialView} inside a {@link SpatialSurface}.
 * Omitting the `modality` prop lets `SpatialSurface` auto-detect GUI vs XR via
 * `window.__elizaXRContext`, so the SAME component serves both surfaces. The TUI
 * surface renders the same `SwapSpatialView` through the terminal registry (see
 * `register-terminal-view.tsx`).
 */

import { SpatialSurface } from "@elizaos/ui/spatial";
import { useCallback } from "react";
import { type SwapSnapshot, SwapSpatialView } from "./SwapSpatialView.tsx";
import type { SwapToken } from "./swap-contracts";
import { type SwapExecuteOutcome, useSwapState } from "./useSwapState";

/**
 * Host props for the unified swap surface. All optional: the spatial wrapper is
 * mounted as an in-process app-shell page / bundled view, not the full-screen
 * overlay, so it needs none of the `OverlayAppContext` callbacks the legacy
 * {@link import("./SwapAppView").SwapAppView} consumed. It only forwards the
 * optional host overrides into the swap state. Keeping them all-optional lets
 * the app-shell loader's `Record<string, unknown>` component typing accept it.
 */
export interface SwapViewProps {
  /** Optional host override for which agent's swap capability to invoke. */
  agentTokenAddress?: string;
  /** Optional host-supplied swap-eligible token list. */
  tokens?: readonly SwapToken[];
  /** Raised when the backend reports the capability is unavailable (404). */
  onUnavailable?: () => void;
}

/** Project the typed execute outcome onto a single display message, or null. */
function outcomeMessage(
  outcome: SwapExecuteOutcome | null,
): { message: string } | null {
  if (!outcome) return null;
  switch (outcome.kind) {
    case "stubbed":
      return { message: outcome.message };
    case "prepared":
      return {
        message: `transaction prepared for ${outcome.to} — sign in your wallet to complete`,
      };
    case "error":
      // The error is surfaced on its own line; no duplicate outcome message.
      return null;
  }
}

export function SwapView({
  agentTokenAddress,
  tokens: tokensProp,
  onUnavailable,
}: SwapViewProps = {}) {
  const {
    tokens,
    tokenIn,
    tokenOut,
    setTokenIn,
    setTokenOut,
    amountIn,
    setAmountIn,
    slippagePct,
    quote,
    canSwap,
    quoting,
    executing,
    error,
    outcome,
    executeSwap,
  } = useSwapState({ agentTokenAddress, tokens: tokensProp, onUnavailable });

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("amount:")) {
        setAmountIn(action.slice("amount:".length));
        return;
      }
      if (action.startsWith("token-in:")) {
        const symbol = action.slice("token-in:".length);
        const next = tokens.find((t) => t.symbol === symbol);
        if (next) setTokenIn(next);
        return;
      }
      if (action.startsWith("token-out:")) {
        const symbol = action.slice("token-out:".length);
        const next = tokens.find((t) => t.symbol === symbol);
        if (next) setTokenOut(next);
        return;
      }
      if (action === "swap") {
        void executeSwap();
      }
    },
    [tokens, setTokenIn, setTokenOut, setAmountIn, executeSwap],
  );

  const snapshot: SwapSnapshot = {
    tokenInSymbol: tokenIn?.symbol ?? "",
    tokenOutSymbol: tokenOut?.symbol ?? "",
    tokenSymbols: tokens.map((t) => t.symbol),
    amountIn,
    slippagePct,
    quote: quote
      ? {
          amountOut: quote.amountOut,
          minAmountOut: quote.minAmountOut,
          priceImpactPct: quote.priceImpactPct,
          source: quote.source,
        }
      : null,
    canSwap,
    quoting,
    executing,
    error: error ? { message: error.message } : null,
    outcome: outcomeMessage(outcome),
  };

  return (
    <SpatialSurface>
      <SwapSpatialView snapshot={snapshot} onAction={onAction} />
    </SpatialSurface>
  );
}
