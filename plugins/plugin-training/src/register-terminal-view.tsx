/**
 * Register the training view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the `training` view's `tui` modality render for real in
 * the terminal (the unified {@link FineTuningSpatialView}) rather than only
 * navigating a GUI shell. A module-level snapshot lets a host push the live
 * training state; with no host it defaults to an empty snapshot.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type FineTuningSnapshot,
  FineTuningSpatialView,
} from "./ui/FineTuningSpatialView.tsx";

const EMPTY: FineTuningSnapshot = {
  runtimeAvailable: false,
  runningJobs: 0,
  queuedJobs: 0,
  completedJobs: 0,
  failedJobs: 0,
  jobs: [],
  models: 0,
  datasets: 0,
  trajectoryCount: 0,
};
let current: FineTuningSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setFineTuningTerminalSnapshot(next: FineTuningSnapshot): void {
  current = next;
}

/** Register the training terminal view; returns an unregister function. */
export function registerFineTuningTerminalView(): () => void {
  return registerSpatialTerminalView("training", () =>
    createElement(FineTuningSpatialView, { snapshot: current }),
  );
}
