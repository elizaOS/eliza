/**
 * Register the Hyperliquid view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the plugin's `viewType: "tui"` declaration render for
 * real in the terminal (the unified {@link HyperliquidSpatialView}) rather than
 * only navigating a GUI shell. A module-level snapshot lets a host push live
 * read state; without one it defaults to a read-blocked, empty dashboard.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
	type HyperliquidSnapshot,
	HyperliquidSpatialView,
} from "./components/HyperliquidSpatialView.tsx";

const EMPTY: HyperliquidSnapshot = {
	status: {
		publicReadReady: false,
		signerReady: false,
		executionReady: false,
		credentialMode: "none",
		accountAddress: null,
		vaultReady: false,
		executionBlockedReason: null,
	},
	markets: [],
	positions: [],
	orders: [],
};

let current: HyperliquidSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setHyperliquidTerminalSnapshot(
	next: HyperliquidSnapshot,
): void {
	current = next;
}

/** Register the Hyperliquid terminal view; returns an unregister function. */
export function registerHyperliquidTerminalView(): () => void {
	return registerSpatialTerminalView("hyperliquid", () =>
		createElement(HyperliquidSpatialView, { snapshot: current }),
	);
}
