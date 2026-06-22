/**
 * Register the finances view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the finances `tui` modality render for real in the
 * terminal (the unified {@link FinancesSpatialView}) rather than only navigating
 * a GUI shell. A module-level snapshot lets a host push live dashboard data;
 * absent a push it defaults to the loading state.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  EMPTY_FINANCES_SNAPSHOT,
  type FinancesSnapshot,
  FinancesSpatialView,
} from "./components/finances/FinancesSpatialView.tsx";

let current: FinancesSnapshot = EMPTY_FINANCES_SNAPSHOT;

/** Update the snapshot the registered terminal view renders from. */
export function setFinancesTerminalSnapshot(next: FinancesSnapshot): void {
  current = next;
}

/** Register the finances terminal view; returns an unregister function. */
export function registerFinancesTerminalView(): () => void {
  return registerSpatialTerminalView("finances", () =>
    createElement(FinancesSpatialView, { snapshot: current }),
  );
}
