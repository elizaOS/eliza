/**
 * Register the Defense of the Agents view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the plugin's `viewType: "tui"` declaration render for
 * real in the terminal (the unified {@link DefenseAgentsSpatialView}) rather
 * than only navigating a GUI shell. A module-level snapshot lets a host push
 * live game telemetry; before a match is joined it defaults to the idle
 * operator panel with no events.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  DefenseAgentsSpatialView,
  type DefenseSnapshot,
} from "./components/DefenseAgentsSpatialView.tsx";

const EMPTY: DefenseSnapshot = {
  status: "idle",
  runId: null,
  canSendCommands: false,
  heroClass: null,
  heroLane: null,
  heroLevel: null,
  heroHp: null,
  heroMaxHp: null,
  autoPlay: false,
  goalLabel: null,
  suggestedPrompts: [],
  events: [],
};

let current: DefenseSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setDefenseTerminalSnapshot(next: DefenseSnapshot): void {
  current = next;
}

/** Register the Defense terminal view; returns an unregister function. */
export function registerDefenseTerminalView(): () => void {
  return registerSpatialTerminalView("defense-of-the-agents", () =>
    createElement(DefenseAgentsSpatialView, { snapshot: current }),
  );
}
