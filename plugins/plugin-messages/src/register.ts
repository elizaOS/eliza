/** Registers the native Messages page with the app shell on the ElizaOS fork. */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { isElizaOS } from "@elizaos/ui/platform/init";
import { MESSAGES_VIEW_CAPABILITIES } from "./view-capabilities";

if (isElizaOS()) {
  registerAppShellPage({
    id: "messages",
    pluginId: "@elizaos/plugin-messages",
    label: "Messages",
    icon: "MessageSquare",
    path: "/messages",
    tabAffinity: "messages",
    order: 902,
    viewKind: "release",
    surface: {
      header: "fullscreen",
      capabilities: [],
    },
    capabilities: MESSAGES_VIEW_CAPABILITIES,
    interact: async (capability, params) => {
      const { interact } = await import("./components/messages-interact");
      return interact(capability, params);
    },
    loader: () =>
      import("./components/MessagesPage.tsx").then((module) => ({
        default: module.MessagesPage,
      })),
  });
}
