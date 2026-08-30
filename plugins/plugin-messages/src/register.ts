/** Registers the native Messages page with the app shell on the ElizaOS fork. */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { isElizaOS } from "@elizaos/ui/platform/init";

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
      capabilities: ["agent-surface"],
    },
    loader: () =>
      import("./components/MessagesPage.tsx").then((module) => ({
        default: module.MessagesPage,
      })),
  });
}
