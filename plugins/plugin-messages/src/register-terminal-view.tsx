/**
 * Register the messages view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the messages `viewType: "tui"` declaration render for
 * real in the terminal (the unified {@link MessagesSpatialView}) rather than
 * only navigating a GUI shell. A module-level snapshot lets a host push live SMS
 * data; on a non-Android agent it defaults to an empty inbox with no SMS role.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type MessagesSnapshot,
  MessagesSpatialView,
} from "./components/MessagesSpatialView.tsx";

const EMPTY: MessagesSnapshot = {
  threads: [],
  selectedThreadId: null,
  composeAddress: "",
  composeBody: "",
  ownsSmsRole: false,
  smsRoleHolder: null,
};
let current: MessagesSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setMessagesTerminalSnapshot(next: MessagesSnapshot): void {
  current = next;
}

/** Register the messages terminal view; returns an unregister function. */
export function registerMessagesTerminalView(): () => void {
  return registerSpatialTerminalView("messages", () =>
    createElement(MessagesSpatialView, { snapshot: current }),
  );
}
