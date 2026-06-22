/**
 * Register the relationships view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the relationships `tui` modality render for real in the
 * terminal (the unified {@link RelationshipsSpatialView}) rather than only
 * navigating a GUI shell. A module-level snapshot lets a host push live graph
 * data; absent a push it defaults to the loading state.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  EMPTY_RELATIONSHIPS,
  type RelationshipsSnapshot,
  RelationshipsSpatialView,
} from "./components/relationships/RelationshipsSpatialView.tsx";

let current: RelationshipsSnapshot = EMPTY_RELATIONSHIPS;

/** Update the snapshot the registered terminal view renders from. */
export function setRelationshipsTerminalSnapshot(
  next: RelationshipsSnapshot,
): void {
  current = next;
}

/** Register the relationships terminal view; returns an unregister function. */
export function registerRelationshipsTerminalView(): () => void {
  return registerSpatialTerminalView("relationships", () =>
    createElement(RelationshipsSpatialView, { snapshot: current }),
  );
}
