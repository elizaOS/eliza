/**
 * Register the orchestrator view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the orchestrator's `viewType: "tui"` declaration render
 * for real in the terminal (the unified {@link OrchestratorSpatialView}) rather
 * than only navigating a GUI shell. A module-level snapshot lets a host push
 * live orchestrator data; with no host the workbench renders an empty,
 * statusless task list.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type OrchestratorSnapshot,
  OrchestratorSpatialView,
} from "./components/OrchestratorSpatialView.tsx";

const EMPTY: OrchestratorSnapshot = {
  status: null,
  threads: [],
  hasMore: false,
  detail: null,
  planSteps: [],
  pendingInputs: [],
};
let current: OrchestratorSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setOrchestratorTerminalSnapshot(
  next: OrchestratorSnapshot,
): void {
  current = next;
}

/** Register the orchestrator terminal view; returns an unregister function. */
export function registerOrchestratorTerminalView(): () => void {
  return registerSpatialTerminalView("orchestrator", () =>
    createElement(OrchestratorSpatialView, { snapshot: current }),
  );
}
