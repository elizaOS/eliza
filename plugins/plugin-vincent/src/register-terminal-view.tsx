/**
 * Register the Vincent view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes Vincent's `viewType: "tui"` declaration render for real
 * in the terminal (the unified {@link VincentSpatialView}) rather than only
 * navigating a GUI shell. A module-level snapshot lets a host push live trading
 * data; on a fresh agent it defaults to the disconnected dashboard.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type VincentSnapshot,
  VincentSpatialView,
} from "./components/VincentSpatialView.tsx";

const EMPTY: VincentSnapshot = {
  vincentConnected: false,
  vincentConnectedAt: null,
  walletAddresses: null,
  walletBalances: null,
  strategy: null,
  tradingProfile: null,
};
let current: VincentSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setVincentTerminalSnapshot(next: VincentSnapshot): void {
  current = next;
}

/** Register the Vincent terminal view; returns an unregister function. */
export function registerVincentTerminalView(): () => void {
  return registerSpatialTerminalView("vincent", () =>
    createElement(VincentSpatialView, { snapshot: current }),
  );
}
