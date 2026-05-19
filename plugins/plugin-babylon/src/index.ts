import type { Plugin } from "@elizaos/core";

const babylonPlugin: Plugin = {
  name: "@elizaos/plugin-babylon",
  description: "Babylon prediction market game operator surface.",
  views: [
    {
      id: "babylon",
      label: "Babylon",
      description: "Babylon prediction market operator dashboard",
      icon: "Gamepad2",
      path: "/babylon",
      bundlePath: "dist/views/bundle.js",
      componentExport: "BabylonOperatorSurface",
      tags: ["game", "prediction-market", "babylon"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "babylon",
      label: "Babylon TUI",
      description: "Terminal Babylon prediction market operator dashboard",
      icon: "Gamepad2",
      path: "/babylon/tui",
      viewType: "tui",
      bundlePath: "dist/views/bundle.js",
      componentExport: "BabylonTuiView",
      capabilities: [
        { id: "get-state", description: "Return Babylon terminal state" },
        {
          id: "refresh-agent-status",
          description: "Refresh agent status, dashboard, and market state",
        },
        {
          id: "open-live-dashboard",
          description: "Return live Babylon dashboard route and endpoints",
        },
        {
          id: "send-team-message",
          description: "Send a Babylon team-chat message",
          params: {
            content: {
              type: "string",
              description: "Message to send to the Babylon team chat",
            },
          },
        },
      ],
      tags: ["game", "prediction-market", "babylon", "terminal"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default babylonPlugin;
export * from "./routes.js";
export * from "./ui/babylon-data.js";
export * from "./ui/index.js";
