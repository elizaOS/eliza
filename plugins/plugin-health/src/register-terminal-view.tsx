/**
 * Register the health view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the health `tui` modality render for real in the terminal
 * (the unified {@link HealthSpatialView}) rather than only navigating a GUI
 * shell. A module-level snapshot lets a host push live sleep data; absent a
 * push it defaults to the loading state.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  EMPTY_HEALTH_SNAPSHOT,
  type HealthSnapshot,
  HealthSpatialView,
} from "./components/health/HealthSpatialView.tsx";

let current: HealthSnapshot = EMPTY_HEALTH_SNAPSHOT;

/** Update the snapshot the registered terminal view renders from. */
export function setHealthTerminalSnapshot(next: HealthSnapshot): void {
  current = next;
}

/** Register the health terminal view; returns an unregister function. */
export function registerHealthTerminalView(): () => void {
  return registerSpatialTerminalView("health", () =>
    createElement(HealthSpatialView, { snapshot: current }),
  );
}
