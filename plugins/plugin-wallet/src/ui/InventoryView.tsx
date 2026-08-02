/**
 * InventoryView is the single registered component for the shipped wallet GUI.
 *
 * It renders a {@link SpatialSurface} wrapping an {@link Escape} hatch. `Escape`
 * renders the full multi-panel {@link InventoryAppView} dashboard (holdings
 * rail, P&L chart, activity log, movers, LP positions, NFT grid).
 * InventoryAppView owns its own wallet data pipeline
 * (balances/NFTs/trading-profile fetch + poll).
 *
 * The wrapper therefore does NO data work — that would double-fetch
 * InventoryAppView's pipeline and feed a snapshot nothing live consumes. This
 * There is one componentExport (`InventoryView`); the rich dashboard is reached
 * only through this wrapper, never registered as a separate app/nav tab.
 */

import { Escape } from "@elizaos/ui/spatial";
import { InventoryAppView } from "./components/InventoryAppView.tsx";

export function InventoryView() {
  return (
    <Escape>
      <InventoryAppView />
    </Escape>
  );
}
