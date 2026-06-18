/**
 * Register the wallet view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the wallet's `viewType: "tui"` declaration render for
 * real in the terminal (the unified {@link InventorySpatialView}) rather than
 * only navigating a GUI shell. A module-level snapshot lets a host push live
 * portfolio data; with no host it defaults to an empty, balance-pending wallet.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  InventorySpatialView,
  type WalletSnapshot,
} from "./components/InventorySpatialView.tsx";

const EMPTY: WalletSnapshot = {
  portfolioValueUsd: 0,
  tokenRows: [],
  walletNfts: [],
  marketMovers: [],
  tradingProfile: { realizedPnlBnb: 0, recentSwaps: [] },
  addresses: { evmAddress: null, solanaAddress: null },
  config: {
    evmBalanceReady: false,
    solanaBalanceReady: false,
    selectedRpcProviders: [],
  },
};

let current: WalletSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setWalletTerminalSnapshot(next: WalletSnapshot): void {
  current = next;
}

/** Register the wallet terminal view; returns an unregister function. */
export function registerWalletTerminalView(): () => void {
  return registerSpatialTerminalView("wallet", () =>
    createElement(InventorySpatialView, { snapshot: current }),
  );
}
