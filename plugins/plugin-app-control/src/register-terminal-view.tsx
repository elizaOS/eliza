/**
 * Register the views-manager view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the `views-manager` `viewType: "tui"` declaration render
 * for real in the terminal (the unified {@link ViewManagerSpatialView}) rather
 * than only navigating a GUI shell. A module-level snapshot lets a host push the
 * live view list; with no host it defaults to an empty list.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
	type ViewManagerSnapshot,
	ViewManagerSpatialView,
} from "./components/ViewManagerSpatialView.tsx";

const EMPTY: ViewManagerSnapshot = { views: [] };
let current: ViewManagerSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setViewManagerTerminalSnapshot(
	next: ViewManagerSnapshot,
): void {
	current = next;
}

/** Register the views-manager terminal view; returns an unregister function. */
export function registerViewManagerTerminalView(): () => void {
	return registerSpatialTerminalView("views-manager", () =>
		createElement(ViewManagerSpatialView, { snapshot: current }),
	);
}
