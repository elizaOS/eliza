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
