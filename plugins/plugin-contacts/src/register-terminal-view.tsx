/**
 * Register the contacts view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the contacts `viewType: "tui"` declaration render for
 * real in the terminal (the unified {@link ContactsSpatialView}) rather than
 * only navigating a GUI shell. A module-level snapshot lets a host push live
 * address-book data; on a non-Android agent it defaults to an empty list.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type ContactsSnapshot,
  ContactsSpatialView,
} from "./components/ContactsSpatialView.tsx";

const EMPTY: ContactsSnapshot = { contacts: [], query: "", mode: "list" };
let current: ContactsSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setContactsTerminalSnapshot(next: ContactsSnapshot): void {
  current = next;
}

/** Register the contacts terminal view; returns an unregister function. */
export function registerContactsTerminalView(): () => void {
  return registerSpatialTerminalView("contacts", () =>
    createElement(ContactsSpatialView, { snapshot: current }),
  );
}
