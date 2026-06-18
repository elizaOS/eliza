/**
 * Register the ClawVille operator view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes ClawVille's `viewType: "tui"` declaration render for real
 * in the terminal (the unified {@link ClawvilleSpatialView}) rather than only
 * navigating a GUI shell. A module-level snapshot lets a host push live run
 * data; on an idle agent it defaults to the empty/waiting panel.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type ClawvilleSnapshot,
  ClawvilleSpatialView,
} from "./components/ClawvilleSpatialView.tsx";

const EMPTY: ClawvilleSnapshot = {
  runId: null,
  status: "idle",
  canSend: false,
  goalLabel: null,
  telemetry: { nearestBuildingLabel: "the reef", knowledgeCount: null },
  actions: [],
  events: [],
};
let current: ClawvilleSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setClawvilleTerminalSnapshot(next: ClawvilleSnapshot): void {
  current = next;
}

/** Register the ClawVille terminal view; returns an unregister function. */
export function registerClawvilleTerminalView(): () => void {
  return registerSpatialTerminalView("clawville", () =>
    createElement(ClawvilleSpatialView, { snapshot: current }),
  );
}
