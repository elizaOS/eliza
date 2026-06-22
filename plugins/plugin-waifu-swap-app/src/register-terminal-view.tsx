/**
 * Register the swap view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the swap `tui` modality render for real in the terminal
 * (the unified {@link SwapSpatialView}) rather than only navigating a GUI shell.
 * A module-level snapshot lets a host push live state; with no host data it
 * defaults to an empty form with no quote.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import { type SwapSnapshot, SwapSpatialView } from "./SwapSpatialView.tsx";
import { DEFAULT_SLIPPAGE_PCT } from "./swap-contracts";

const EMPTY: SwapSnapshot = {
  tokenInSymbol: "",
  tokenOutSymbol: "",
  tokenSymbols: [],
  amountIn: "",
  slippagePct: DEFAULT_SLIPPAGE_PCT,
  quote: null,
  canSwap: false,
  quoting: false,
  executing: false,
  error: null,
  outcome: null,
};

let current: SwapSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setSwapTerminalSnapshot(next: SwapSnapshot): void {
  current = next;
}

/** Register the swap terminal view; returns an unregister function. */
export function registerSwapTerminalView(): () => void {
  return registerSpatialTerminalView("waifu-swap", () =>
    createElement(SwapSpatialView, { snapshot: current }),
  );
}
