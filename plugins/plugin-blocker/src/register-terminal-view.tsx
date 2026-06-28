/**
 * Register the Focus view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the blocker `modalities: [..., "tui"]` declaration (id
 * "focus") render for real in the terminal (the unified {@link FocusSpatialView})
 * rather than only navigating a GUI shell. A module-level snapshot lets a host
 * push live status; absent a host it defaults to the loading phase.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type FocusSnapshot,
  FocusSpatialView,
} from "./components/focus/FocusSpatialView.tsx";

const INITIAL: FocusSnapshot = { phase: "loading" };
let current: FocusSnapshot = INITIAL;

/** Update the snapshot the registered terminal view renders from. */
export function setFocusTerminalSnapshot(next: FocusSnapshot): void {
  current = next;
}

/** Register the Focus terminal view; returns an unregister function. */
export function registerFocusTerminalView(): () => void {
  return registerSpatialTerminalView("focus", () =>
    createElement(FocusSpatialView, { snapshot: current }),
  );
}
