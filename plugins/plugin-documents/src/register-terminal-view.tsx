/**
 * Register the documents view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the documents `tui` modality render for real in the
 * terminal (the unified {@link DocumentsSpatialView}) rather than only
 * navigating a GUI shell. A module-level snapshot lets a host push live store
 * data; absent a push it defaults to the loading state.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type DocumentsSnapshot,
  DocumentsSpatialView,
  EMPTY_DOCUMENTS_SNAPSHOT,
} from "./components/documents/DocumentsSpatialView.tsx";

let current: DocumentsSnapshot = EMPTY_DOCUMENTS_SNAPSHOT;

/** Update the snapshot the registered terminal view renders from. */
export function setDocumentsTerminalSnapshot(next: DocumentsSnapshot): void {
  current = next;
}

/** Register the documents terminal view; returns an unregister function. */
export function registerDocumentsTerminalView(): () => void {
  return registerSpatialTerminalView("documents", () =>
    createElement(DocumentsSpatialView, { snapshot: current }),
  );
}
