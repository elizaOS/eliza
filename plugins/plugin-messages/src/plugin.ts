import type { Plugin } from "@elizaos/core";

export const appMessagesPlugin: Plugin = {
  name: "@elizaos/app-messages",
  description:
    "Android Messages overlay: read SMS conversations and compose text messages through the native SMS bridge.",
  views: [
    {
      id: "messages",
      label: "Messages",
      description: "SMS conversations via the Android Messages bridge",
      icon: "MessageSquare",
      path: "/messages",
      bundlePath: "dist/views/bundle.js",
      componentExport: "MessagesAppView",
      tags: ["messaging", "sms", "android"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default appMessagesPlugin;
