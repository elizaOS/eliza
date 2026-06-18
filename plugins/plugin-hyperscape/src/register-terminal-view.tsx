/**
 * Register the Hyperscape operator view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes Hyperscape's `viewType: "tui"` declaration render for
 * real in the terminal (the unified {@link HyperscapeSpatialView}) rather than
 * only navigating a GUI shell. A module-level snapshot lets a host push live run
 * data; with no run resolved it defaults to the empty "no active run" panel.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type HyperscapeSnapshot,
  HyperscapeSpatialView,
} from "./components/HyperscapeSpatialView.tsx";

const EMPTY: HyperscapeSnapshot = { run: null };
let current: HyperscapeSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setHyperscapeTerminalSnapshot(next: HyperscapeSnapshot): void {
  current = next;
}

/** Register the Hyperscape terminal view; returns an unregister function. */
export function registerHyperscapeTerminalView(): () => void {
  return registerSpatialTerminalView("hyperscape", () =>
    createElement(HyperscapeSpatialView, { snapshot: current }),
  );
}
