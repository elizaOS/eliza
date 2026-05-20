import type { Plugin } from "@elizaos/core";

export const appMessagesPlugin: Plugin = {
  name: "@elizaos/plugin-messages",
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
    {
      id: "messages",
      label: "Messages XR",
      description: "SMS conversations via the Android Messages bridge",
      icon: "MessageSquare",
      path: "/messages",
      viewType: "xr",
      bundlePath: "dist/views/bundle.js",
      componentExport: "MessagesAppView",
      tags: ["messaging", "sms", "android"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "messages",
      label: "Messages TUI",
      description: "Terminal SMS conversation surface and bridge status",
      icon: "MessageSquare",
      path: "/messages/tui",
      viewType: "tui",
      bundlePath: "dist/views/bundle.js",
      componentExport: "MessagesTuiView",
      tags: ["messaging", "sms", "android", "terminal"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default appMessagesPlugin;
