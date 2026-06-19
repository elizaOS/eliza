import type { Plugin } from "@elizaos/core";

const feedPlugin: Plugin = {
  name: "@elizaos/plugin-feed",
  description: "Feed prediction market game operator surface.",
  views: [
    {
      id: "feed",
      label: "Feed",
      description: "Feed prediction market operator dashboard",
      icon: "Gamepad2",
      path: "/feed",
      bundlePath: "dist/views/bundle.js",
      componentExport: "FeedOperatorSurface",
      tags: ["game", "prediction-market", "feed"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "feed",
      label: "Feed XR",
      description: "Feed prediction market operator dashboard",
      icon: "Gamepad2",
      path: "/feed",
      viewType: "xr",
      bundlePath: "dist/views/bundle.js",
      componentExport: "FeedOperatorSurface",
      tags: ["game", "prediction-market", "feed"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "feed",
      label: "Feed TUI",
      description: "Terminal Feed prediction market operator dashboard",
      icon: "Gamepad2",
      path: "/feed/tui",
      viewType: "tui",
      bundlePath: "dist/views/bundle.js",
      componentExport: "FeedTuiView",
      capabilities: [
        { id: "get-state", description: "Return Feed terminal state" },
        {
          id: "refresh-agent-status",
          description: "Refresh agent status, dashboard, and market state",
        },
        {
          id: "open-live-dashboard",
          description: "Return live Feed dashboard route and endpoints",
        },
        {
          id: "send-team-message",
          description: "Send a Feed team-chat message",
          params: {
            content: {
              type: "string",
              description: "Message to send to the Feed team chat",
            },
          },
        },
      ],
      tags: ["game", "prediction-market", "feed", "terminal"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

// In a terminal host (the Node agent, no DOM), register the Feed view so it
// renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
// stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view.js")
    .then((m) => m.registerFeedTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}

export default feedPlugin;
export * from "./routes.js";
export * from "./ui/feed-data.js";
export * from "./ui/index.js";
