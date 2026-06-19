/**
 * Register the 2004scape view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the plugin's `viewType: "tui"` declaration render for real
 * in the terminal (the unified {@link TwoThousandFourScapeSpatialView}) rather
 * than only navigating a GUI shell. A module-level snapshot lets a host push live
 * session telemetry; before a run exists it defaults to the standby panel.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  EMPTY_2004SCAPE_SNAPSHOT,
  type TwoThousandFourScapeSnapshot,
  TwoThousandFourScapeSpatialView,
} from "./components/TwoThousandFourScapeSpatialView.tsx";

let current: TwoThousandFourScapeSnapshot = EMPTY_2004SCAPE_SNAPSHOT;

/** Update the snapshot the registered terminal view renders from. */
export function setTwoThousandFourScapeTerminalSnapshot(
  next: TwoThousandFourScapeSnapshot,
): void {
  current = next;
}

/** Register the 2004scape terminal view; returns an unregister function. */
export function registerTwoThousandFourScapeTerminalView(): () => void {
  return registerSpatialTerminalView("2004scape", () =>
    createElement(TwoThousandFourScapeSpatialView, { snapshot: current }),
  );
}
