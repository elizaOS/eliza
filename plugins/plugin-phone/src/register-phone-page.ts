/**
 * Registers the native dialer and recent-calls surface with the app shell.
 * Android packages this component in-process, where remote view bundles are
 * intentionally unavailable.
 */

import { Capacitor } from "@capacitor/core";
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

if (Capacitor.getPlatform() === "android") {
  registerAppShellPage({
    id: "phone",
    pluginId: "@elizaos/plugin-phone",
    label: "Phone",
    icon: "Phone",
    path: "/phone",
    tabAffinity: "phone",
    surface: {
      header: "fullscreen",
      capabilities: ["agent-surface"],
    },
    loader: () =>
      import("./components/PhonePage.tsx").then((module) => ({
        default: module.PhonePage,
      })),
  });
}
