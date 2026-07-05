import type { Plugin } from "@elizaos/core";

const feedPlugin: Plugin = {
  name: "@elizaos/plugin-feed",
  description: "Feed prediction market game operator surface.",
  views: [
    // ONE declaration → GUI + XR + TUI, all drawn from the single FeedView
    // spatial source. `modalities` is a plain literal here (index.ts is not in
    // the view bundle), so no brand-new `@elizaos/core` runtime export reaches
    // the bundle build. The terminal surface mounts the same FeedSpatialView via
    // register-terminal-view.tsx.
    {
      id: "feed",
      viewKind: "system",
      label: "Feed",
      description: "Feed prediction market operator dashboard",
      icon: "Gamepad2",
      path: "/feed",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "FeedView",
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
      tags: ["game", "prediction-market", "feed"],
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
// NOTE: only the pure proxy + data layers are re-exported here. The Node agent
// imports this entry to register the plugin's views; pulling React/UI in would
// break that bundle. The GUI/XR surface loads from the dedicated view bundle
// (src/ui/feed-view-bundle.ts → FeedView), and the terminal surface mounts the
// same FeedSpatialView via register-terminal-view.tsx.
