import { type OverlayApp, registerOverlayApp } from "@elizaos/ui";
import { MessagesAppView } from "./MessagesAppView";

export const MESSAGES_APP_NAME = "@elizaos/app-messages";

export const messagesApp: OverlayApp = {
  name: MESSAGES_APP_NAME,
  displayName: "Messages",
  description: "SMS inbox, threads, and compose for Android",
  category: "system",
  icon: null,
  androidOnly: true,
  Component: MessagesAppView,
};

export function registerMessagesApp(): void {
  registerOverlayApp(messagesApp);
}
