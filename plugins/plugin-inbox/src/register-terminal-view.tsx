/**
 * Register the inbox view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the inbox `tui` modality render for real in the terminal
 * (the unified {@link InboxSpatialView}) rather than only navigating a GUI
 * shell. A module-level snapshot lets a host push live inbox data; on a host
 * with no inbox data it defaults to the loading snapshot.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  EMPTY_INBOX_SNAPSHOT,
  type InboxSnapshot,
  InboxSpatialView,
} from "./components/inbox/InboxSpatialView.tsx";

let current: InboxSnapshot = EMPTY_INBOX_SNAPSHOT;

/** Update the snapshot the registered terminal view renders from. */
export function setInboxTerminalSnapshot(next: InboxSnapshot): void {
  current = next;
}

/** Register the inbox terminal view; returns an unregister function. */
export function registerInboxTerminalView(): () => void {
  return registerSpatialTerminalView("inbox", () =>
    createElement(InboxSpatialView, { snapshot: current }),
  );
}
