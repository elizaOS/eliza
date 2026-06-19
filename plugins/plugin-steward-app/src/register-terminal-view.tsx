/**
 * Register the Steward view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes Steward's `viewType: "tui"` declaration render for real
 * in the terminal (the unified {@link StewardSpatialView}) rather than only
 * navigating a GUI shell. A module-level snapshot lets a host push live vault
 * data; with no Steward bridge configured it defaults to a disconnected panel.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type StewardSnapshot,
  StewardSpatialView,
} from "./components/StewardSpatialView.tsx";

const EMPTY: StewardSnapshot = {
  tab: "approvals",
  connected: false,
  configured: false,
  available: false,
  evmAddress: null,
  pendingApprovals: [],
  history: [],
  historyTotal: 0,
  statusFilter: null,
  chainFilter: null,
  page: 0,
  pageSize: 25,
};

let current: StewardSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setStewardTerminalSnapshot(next: StewardSnapshot): void {
  current = next;
}

/** Register the Steward terminal view; returns an unregister function. */
export function registerStewardTerminalView(): () => void {
  return registerSpatialTerminalView("steward", () =>
    createElement(StewardSpatialView, { snapshot: current }),
  );
}
