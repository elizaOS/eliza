import { type OverlayApp, registerOverlayApp } from "@elizaos/ui";

export const MESSAGES_APP_NAME = "@elizaos/plugin-messages";

export const messagesApp: OverlayApp = {
  name: MESSAGES_APP_NAME,
  displayName: "Messages",
  description: "SMS inbox, threads, and compose for Android",
  category: "system",
  icon: null,
  androidOnly: true,
  loader: () =>
    import("./MessagesAppView").then((m) => ({ default: m.MessagesAppView })),
};

export function registerMessagesApp(): void {
  registerOverlayApp(messagesApp);
}
