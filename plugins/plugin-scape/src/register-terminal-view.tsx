/**
 * Register the 'scape operator view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes 'scape's `viewType: "tui"` declaration render for real in
 * the terminal (the unified {@link ScapeSpatialView}) rather than only
 * navigating a GUI shell. A module-level snapshot lets a host push live operator
 * telemetry; with no live run it defaults to an idle, command-unavailable frame.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type ScapeSnapshot,
  ScapeSpatialView,
} from "./components/ScapeSpatialView.tsx";

const EMPTY: ScapeSnapshot = {
  connectionStatus: "idle",
  pausedByOperator: false,
  operatorGoal: null,
  canSend: false,
  activeGoal: null,
  agent: null,
  skills: [],
  inventory: [],
  nearbyNpcs: [],
  nearbyPlayers: [],
  nearbyItems: [],
  memoryCount: 0,
  recentMemories: [],
  recentActions: [],
  suggestedPrompts: [],
};

let current: ScapeSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setScapeTerminalSnapshot(next: ScapeSnapshot): void {
  current = next;
}

/** Register the 'scape terminal view; returns an unregister function. */
export function registerScapeTerminalView(): () => void {
  return registerSpatialTerminalView("scape", () =>
    createElement(ScapeSpatialView, { snapshot: current }),
  );
}
