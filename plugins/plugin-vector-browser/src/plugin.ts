import type { Plugin } from "@elizaos/core";

/**
 * Vector browser plugin.
 *
 * Contributes the heavy three.js (WebGL) vector-browser surface as a
 * dynamically loaded view so neither the component nor three ship in the
 * always-loaded @elizaos/ui bundle. The view is served by the agent router at
 * `/api/views/vector-browser/bundle.js` and mounted by the shell's
 * DynamicViewLoader.
 *
 * Modalities — one adaptive `componentExport` (`VectorBrowserView`) wraps the
 * rich surface in a spatial `Escape`:
 *   - GUI / XR — `Escape` renders the rich `VectorBrowserRichView` as real DOM:
 *     the 3D point cloud (three.js / WebGL) and the 2D canvas projection. These
 *     are INFEASIBLE in a terminal, so they stay GUI/XR-only.
 *   - TUI      — the `Escape` fallback (and the terminal registry, see
 *     `register-terminal-view.tsx`) render the SAME `VectorBrowserSpatialView`:
 *     a presentational summary-stats (vectors / with-embeddings / dim /
 *     clusters / table) + points-list fallback, with a "3D point cloud renders
 *     in GUI/XR" note.
 */
export const vectorBrowserPlugin: Plugin = {
  name: "@elizaos/plugin-vector-browser",
  description:
    "Vector/memory browser with list, 2D projection, and 3D (WebGL) views",
  views: [
    {
      id: "vector-browser",
      label: "Vector Browser",
      developerOnly: true,
      description:
        "Browse agent memories and visualise their embeddings as a 2D or 3D projection",
      icon: "ScatterChart",
      path: "/vector-browser",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "VectorBrowserView",
      tags: ["memory", "embeddings", "vectors", "database"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};
