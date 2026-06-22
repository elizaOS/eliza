/**
 * Register the trajectory logger view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the trajectory logger's `"tui"` modality render for real
 * in the terminal (the unified {@link TrajectoryLoggerSpatialView}) rather than
 * only navigating a GUI shell.
 * A module-level snapshot lets a host push live trajectory data; with no host it
 * defaults to the empty "no turn yet" state.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  EMPTY_TRAJECTORY_SNAPSHOT,
  TrajectoryLoggerSpatialView,
  type TrajectorySnapshot,
} from "./components/TrajectoryLoggerSpatialView.tsx";

let current: TrajectorySnapshot = EMPTY_TRAJECTORY_SNAPSHOT;

/** Update the snapshot the registered terminal view renders from. */
export function setTrajectoryLoggerTerminalSnapshot(
  next: TrajectorySnapshot,
): void {
  current = next;
}

/** Register the trajectory logger terminal view; returns an unregister function. */
export function registerTrajectoryLoggerTerminalView(): () => void {
  return registerSpatialTerminalView("trajectory-logger", () =>
    createElement(TrajectoryLoggerSpatialView, { snapshot: current }),
  );
}
