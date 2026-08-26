/**
 * Registers the Eliza Cloud dashboard as a signed app-shell page. Runtime
 * Cloud services remain in the plugin's normal runtime entry; this module only
 * contributes the renderer surface for hosts that cannot load remote bundles.
 */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

registerAppShellPage({
  id: "cloud",
  pluginId: "@elizaos/plugin-elizacloud",
  label: "Cloud",
  icon: "Cloud",
  path: "/cloud",
  order: 940,
  viewKind: "release",
  surface: {
    header: "fullscreen",
    capabilities: ["agent-surface"],
  },
  loader: () =>
    import("./components/cloud/CloudPage.tsx").then((module) => ({
      default: module.CloudPage,
    })),
});
