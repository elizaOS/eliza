import type { Plugin } from "@elizaos/core";

/**
 * Vector browser plugin.
 *
 * Contributes the heavy three.js (WebGL) vector-browser surface as a
 * dynamically loaded view so neither the component nor three ship in the
 * always-loaded @elizaos/ui bundle. The view is served by the agent router at
 * `/api/views/vector-browser/bundle.js` and mounted by the shell's
 * DynamicViewLoader.
 */
export const vectorBrowserPlugin: Plugin = {
  name: "@elizaos/plugin-vector-browser",
  description:
    "Vector/memory browser with list, 2D projection, and 3D (WebGL) views",
  views: [
    {
      id: "vector-browser",
      label: "Vector Browser",
      description:
        "Browse agent memories and visualise their embeddings as a 2D or 3D projection",
      icon: "ScatterChart",
      path: "/vector-browser",
      bundlePath: "dist/views/bundle.js",
      componentExport: "VectorBrowserView",
      tags: ["memory", "embeddings", "vectors", "database"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};
