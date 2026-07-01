/**
 * Register the vector-browser view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the `vector-browser` `tui` modality render for real in
 * the terminal (the {@link VectorBrowserSpatialView} summary-stats + points-list
 * fallback) rather than only navigating a GUI shell. The rich WebGL surface
 * (three.js 3D point cloud + 2D canvas projection) stays GUI/XR-only.
 *
 * A module-level snapshot lets a host push the live memory/embedding stats; with
 * no host it defaults to an empty, zeroed snapshot.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type VectorBrowserSnapshot,
  VectorBrowserSpatialView,
} from "./VectorBrowserSpatialView.tsx";

const EMPTY: VectorBrowserSnapshot = {
  vectorCount: 0,
  withEmbeddings: 0,
  dimension: 0,
  typeCount: 0,
  points: [],
};

let current: VectorBrowserSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setVectorBrowserTerminalSnapshot(
  next: VectorBrowserSnapshot,
): void {
  current = next;
}

/** Register the vector-browser terminal view; returns an unregister function. */
export function registerVectorBrowserTerminalView(): () => void {
  return registerSpatialTerminalView("vector-browser", () =>
    createElement(VectorBrowserSpatialView, { snapshot: current }),
  );
}
