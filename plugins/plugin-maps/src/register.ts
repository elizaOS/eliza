/**
 * Statically registers the routed /maps page with the app shell.
 *
 * Native clients prohibit remotely supplied JavaScript, so the renderer is a
 * lazy chunk in the signed app bundle while the runtime plugin supplies only
 * metadata, capabilities, and durable state.
 */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

registerAppShellPage({
  id: "maps",
  pluginId: "@elizaos/plugin-maps",
  label: "Maps",
  icon: "Map",
  path: "/maps",
  order: 930,
  viewKind: "release",
  surface: { header: "fullscreen" },
  loader: () =>
    import("./views/MapsView.tsx").then((module) => ({
      default: module.MapsView,
    })),
});
