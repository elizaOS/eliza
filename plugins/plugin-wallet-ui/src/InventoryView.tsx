/**
 * InventoryView — the single registered component for the wallet surface across
 * GUI, XR, and TUI.
 *
 * It renders a {@link SpatialSurface} wrapping an {@link Escape} hatch:
 *
 *   - GUI / XR — `Escape` renders its real DOM children, the full multi-panel
 *     {@link InventoryAppView} dashboard (holdings rail, P&L chart, activity log,
 *     movers, LP positions, NFT grid). InventoryAppView owns its own wallet data
 *     pipeline (balances/NFTs/trading-profile fetch + poll).
 *   - TUI      — the agent terminal mounts {@link InventorySpatialView} directly
 *     through the terminal registry (`register-terminal-view.tsx`, fed live by
 *     `setWalletTerminalSnapshot`). `Escape` never renders its DOM children in a
 *     terminal, so its `tui` prop is a static fallback for the rare bundle-
 *     evaluated TUI path and gets a zeroed snapshot.
 *
 * The wrapper therefore does NO data work — that would double-fetch
 * InventoryAppView's pipeline and feed a snapshot nothing live consumes. This
 * matches the vector-browser / orchestrator / training escape-wraps. There is one
 * componentExport (`InventoryView`); the rich dashboard is reached only through
 * this wrapper, never registered as a separate app/nav tab.
 */

import { Escape, SpatialSurface } from "@elizaos/ui/spatial";
import { InventoryAppView } from "./components/InventoryAppView.tsx";
import {
  InventorySpatialView,
  type WalletSnapshot,
} from "./components/InventorySpatialView.tsx";

const TUI_FALLBACK_SNAPSHOT: WalletSnapshot = {
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

export function InventoryView() {
  return (
    <SpatialSurface>
      <Escape
        tui={
          <InventorySpatialView
            snapshot={TUI_FALLBACK_SNAPSHOT}
            onAction={() => {}}
          />
        }
      >
        <InventoryAppView />
      </Escape>
    </SpatialSurface>
  );
}
