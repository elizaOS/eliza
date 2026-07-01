/**
 * Register the calendar view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the calendar `modalities: ["…","tui"]` declaration render
 * for real in the terminal (the unified {@link CalendarSpatialView}) rather than
 * only navigating a GUI shell. A module-level snapshot lets a host push live
 * agenda data; with no host update it defaults to an empty agenda.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type CalendarSnapshot,
  CalendarSpatialView,
} from "./components/calendar/CalendarSpatialView.tsx";

const EMPTY: CalendarSnapshot = {
  events: [],
  periodLabel: "Calendar",
  mode: "week",
};
let current: CalendarSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setCalendarTerminalSnapshot(next: CalendarSnapshot): void {
  current = next;
}

/** Register the calendar terminal view; returns an unregister function. */
export function registerCalendarTerminalView(): () => void {
  return registerSpatialTerminalView("calendar", () =>
    createElement(CalendarSpatialView, { snapshot: current }),
  );
}
