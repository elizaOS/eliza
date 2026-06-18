/**
 * Register the screen-share view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the screen-share `viewType: "tui"` declaration render for
 * real in the terminal (the unified {@link ScreenshareSpatialView}) rather than
 * only navigating a GUI shell. A module-level snapshot lets a host push live
 * session + capability data; with no session it defaults to an idle dashboard.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type ScreenshareSnapshot,
  ScreenshareSpatialView,
} from "./components/ScreenshareSpatialView.tsx";

const EMPTY: ScreenshareSnapshot = {
  platform: "desktop",
  session: null,
  capabilities: [],
  host: null,
  remote: null,
};
let current: ScreenshareSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setScreenshareTerminalSnapshot(
  next: ScreenshareSnapshot,
): void {
  current = next;
}

/** Register the screen-share terminal view; returns an unregister function. */
export function registerScreenshareTerminalView(): () => void {
  return registerSpatialTerminalView("screenshare", () =>
    createElement(ScreenshareSpatialView, { snapshot: current }),
  );
}
