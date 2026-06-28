/**
 * Renderer side-effect entry for the Feed view.
 *
 * Web/desktop prefer the agent-served view bundle when it is available. Native
 * shells cannot load remote JS, so this also registers the already-bundled
 * FeedView as an in-process app-shell page.
 */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

registerAppShellPage({
  id: "feed",
  pluginId: "@elizaos/plugin-feed",
  label: "Feed",
  icon: "Gamepad2",
  path: "/feed",
  loader: () =>
    import("./ui/feed-view-bundle.ts").then((module) => ({
      default: module.FeedView,
    })),
});

// In a terminal host (the Node agent, no DOM), register the Feed view so it
// renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
// stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view")
    .then((m) => m.registerFeedTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
