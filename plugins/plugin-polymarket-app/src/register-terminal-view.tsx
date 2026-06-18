/**
 * Register the Polymarket view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes Polymarket's `viewType: "tui"` declaration render for real
 * in the terminal (the unified {@link PolymarketSpatialView}) rather than only
 * navigating a GUI shell. A module-level snapshot lets a host push live market
 * data; before any data loads it defaults to an empty, read-blocked view.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type PolymarketSnapshot,
  PolymarketSpatialView,
} from "./components/PolymarketSpatialView.tsx";

const EMPTY: PolymarketSnapshot = {
  status: null,
  markets: [],
  selectedMarket: null,
};
let current: PolymarketSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setPolymarketTerminalSnapshot(next: PolymarketSnapshot): void {
  current = next;
}

/** Register the Polymarket terminal view; returns an unregister function. */
export function registerPolymarketTerminalView(): () => void {
  return registerSpatialTerminalView("polymarket", () =>
    createElement(PolymarketSpatialView, { snapshot: current }),
  );
}
