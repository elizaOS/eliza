/**
 * Register the LifeOps view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the spatial terminal-view
 * registry. This makes the LifeOps dashboard render for real in the terminal
 * (the unified {@link LifeOpsSpatialView}) rather than only navigating a GUI
 * shell. A module-level snapshot lets a host push live overview data; with no
 * host it defaults to the empty dashboard.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  EMPTY_LIFEOPS_SNAPSHOT,
  type LifeOpsSnapshot,
  LifeOpsSpatialView,
} from "./components/LifeOpsSpatialView.tsx";

let current: LifeOpsSnapshot = EMPTY_LIFEOPS_SNAPSHOT;

/** Update the snapshot the registered terminal view renders from. */
export function setLifeOpsTerminalSnapshot(next: LifeOpsSnapshot): void {
  current = next;
}

/** Register the LifeOps terminal view; returns an unregister function. */
export function registerLifeOpsTerminalView(): () => void {
  return registerSpatialTerminalView("lifeops", () =>
    createElement(LifeOpsSpatialView, { snapshot: current }),
  );
}
