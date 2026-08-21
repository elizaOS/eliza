/** Registers Maps as a signed app-shell page for native and offline clients. */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

registerAppShellPage({
  id: "maps",
  pluginId: "@elizaos/plugin-maps",
  label: "Maps",
  icon: "Map",
  path: "/maps",
  order: 925,
  viewKind: "release",
  surface: {
    header: "fullscreen",
    capabilities: ["agent-surface"],
  },
  loader: () =>
    import("./components/MapsView.tsx").then((module) => ({
      default: module.MapsView,
    })),
});
