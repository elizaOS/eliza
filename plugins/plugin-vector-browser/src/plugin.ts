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
 * One adaptive `componentExport` (`VectorBrowserView`) wraps the rich surface
 * in a spatial `Escape`: the GUI renders the rich `VectorBrowserRichView` as
 * real DOM — the 3D point cloud (three.js / WebGL) and the 2D canvas
 * projection — with the presentational `VectorBrowserSpatialView` as the
 * `Escape` fallback. Only the GUI modality ships; "xr" and "tui" remain
 * compatibility values in the manifest schema.
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
      modalities: ["gui"],
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
