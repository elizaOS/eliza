import { isElizaOS, registerAppShellPage } from "@elizaos/ui";
import { MESSAGES_VIEW_CAPABILITIES } from "./view-capabilities";

export function registerApp(): void {
  if (isElizaOS()) {
    registerAppShellPage({
      id: "messages",
      pluginId: "@elizaos/plugin-native-messages",
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
}
