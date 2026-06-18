/**
 * Register the phone view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the phone's `viewType: "tui"` declaration render for real
 * in the terminal (the unified {@link PhoneSpatialView}) rather than only
 * navigating a GUI shell. A module-level snapshot lets a host push live call
 * data; on a non-Android agent it defaults to the dialer with no recent calls.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type PhoneSnapshot,
  PhoneSpatialView,
} from "./components/PhoneSpatialView.tsx";

const EMPTY: PhoneSnapshot = { callReady: false, dialed: "", calls: [] };
let current: PhoneSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setPhoneTerminalSnapshot(next: PhoneSnapshot): void {
  current = next;
}

/** Register the phone terminal view; returns an unregister function. */
export function registerPhoneTerminalView(): () => void {
  return registerSpatialTerminalView("phone", () =>
    createElement(PhoneSpatialView, { snapshot: current }),
  );
}
