import type { Plugin } from "@elizaos/core";

/**
 * `@elizaos/plugin-hyperscape` plugin entry point.
 *
 * Provides session resolvers for the Hyperscape game integration.
 * The route module (`./routes.ts`) handles live session resolution
 * by fetching data from the Hyperscape API.
 */
const hyperscapePlugin: Plugin = {
  name: "@elizaos/plugin-hyperscape",
  description:
    "Hyperscape game session resolvers — spectate-and-steer agent sessions with live data from the Hyperscape API.",
  views: [
    {
      id: "hyperscape",
      label: "Hyperscape",
      description: "Hyperscape game spectator and operator surface",
      icon: "Gamepad2",
      path: "/hyperscape",
      bundlePath: "dist/views/bundle.js",
      componentExport: "HyperscapeOperatorSurface",
      tags: ["game", "hyperscape"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "hyperscape",
      label: "Hyperscape XR",
      description: "Hyperscape game spectator and operator surface",
      icon: "Gamepad2",
      path: "/hyperscape",
      viewType: "xr",
      bundlePath: "dist/views/bundle.js",
      componentExport: "HyperscapeOperatorSurface",
      tags: ["game", "hyperscape"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "hyperscape",
      label: "Hyperscape TUI",
      description: "Terminal Hyperscape operator surface",
      icon: "Gamepad2",
      path: "/hyperscape/tui",
      viewType: "tui",
      bundlePath: "dist/views/bundle.js",
      componentExport: "HyperscapeTuiView",
      tags: ["game", "hyperscape", "terminal"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default hyperscapePlugin;
export * from "./routes.js";
export * from "./ui/index.js";
