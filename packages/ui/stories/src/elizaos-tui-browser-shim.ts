/**
 * Browser shim for `@elizaos/tui` used by the stories dev server.
 *
 * The spatial views' `register-terminal-view.tsx` modules import
 * `@elizaos/ui/spatial/tui`, which imports `@elizaos/tui`. The full `@elizaos/tui`
 * entry pulls in the terminal engine (`autocomplete.ts` does a top-level
 * `node:child_process` access in its built form), which throws under Vite's
 * browser externalization. The browser only needs the PURE pieces the spatial
 * renderer touches: the terminal-view registry (so thunk registration works) and
 * the width/truncation string utils. This shim re-exports exactly those from
 * source — no terminal/stdin/child_process — so the registry populates in the
 * browser and the GUI/XR surfaces mount the real registered views.
 */

export type { Component } from "../../../tui/src/core/types.ts";
export {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "../../../tui/src/utils.ts";
export {
  getTerminalView,
  getTerminalViewFactory,
  hasTerminalView,
  listTerminalViewIds,
  registerTerminalView,
  type TerminalViewFactory,
  type TerminalViewMountOptions,
} from "../../../tui/src/view-registry.ts";
