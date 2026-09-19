/**
 * Registers the Eliza Cloud dashboard as a signed app-shell page. Runtime
 * Cloud services remain in the plugin's normal runtime entry; this module only
 * contributes the renderer surface for hosts that cannot load remote bundles.
 */

import {
  listAppShellPages,
  registerAppShellPage,
} from "@elizaos/ui/app-shell-registry";

// The web host owns the authenticated /cloud/* account route family. Its
// registration can finish before this deferred plugin module loads; replacing
// it would drop nested routes and send billing/agent links to the launcher.
// Hosts without that account shell still receive the signed plugin page.
if (!listAppShellPages().some((page) => page.id === "cloud")) {
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
}
