/**
 * Register the goals view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the goals view render for real in the terminal (the
 * unified {@link GoalsSpatialView}) rather than only navigating a GUI shell. A
 * module-level snapshot lets a host push live goals data; with no host push it
 * defaults to an empty, ready list.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type GoalsSnapshot,
  GoalsSpatialView,
} from "./components/goals/GoalsSpatialView.tsx";

const EMPTY: GoalsSnapshot = {
  status: "ready",
  goals: [],
  activeStatuses: [],
};
let current: GoalsSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setGoalsTerminalSnapshot(next: GoalsSnapshot): void {
  current = next;
}

/** Register the goals terminal view; returns an unregister function. */
export function registerGoalsTerminalView(): () => void {
  return registerSpatialTerminalView("goals", () =>
    createElement(GoalsSpatialView, { snapshot: current }),
  );
}
