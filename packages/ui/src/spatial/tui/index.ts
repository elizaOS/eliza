/**
 * `@elizaos/ui/spatial/tui` — the terminal renderer for unified spatial views.
 *
 * Node-only (depends on `@elizaos/tui`). Import this from a terminal host (the
 * agent CLI), never from browser code — the browser uses `@elizaos/ui/spatial`.
 */

// Re-export the terminal-view registry so plugins/hosts use one import surface.
export {
  getTerminalView,
  hasTerminalView,
  listTerminalViewIds,
  registerTerminalView,
} from "@elizaos/tui";
export { measureWidth, render as renderSpatialNode } from "./engine.ts";
export {
  createSpatialTuiComponent,
  registerSpatialTerminalView,
  renderSpatialToLines,
  renderViewToLines,
  type SpatialTuiComponentOptions,
} from "./renderer.ts";
