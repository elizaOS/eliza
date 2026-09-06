/**
 * Registers the native dialer and recent-calls surface with the app shell.
 * Android packages this component in-process, where remote view bundles are
 * intentionally unavailable.
 */

import { Capacitor } from "@capacitor/core";
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { PHONE_VIEW_CAPABILITIES } from "./view-capabilities";

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
      capabilities: [],
    },
    capabilities: PHONE_VIEW_CAPABILITIES,
    interact: async (capability, params) => {
      const { interact } = await import("./components/phone-interact");
      return interact(capability, params);
    },
    loader: () =>
      import("./components/PhonePage.tsx").then((module) => ({
        default: module.PhonePage,
      })),
  });
}
