/**
 * Side-effect module: registers the vector-browser plugin (and therefore its
 * standalone view) with the app-route plugin registry so the agent can resolve
 * `Plugin.views` and serve `/api/views/vector-browser/bundle.js`.
 *
 * Hosts that bundle @elizaos/plugin-vector-browser should load this module once
 * at boot. The view bundle itself (and three) is only fetched when the view is
 * actually mounted, so this registration adds no eager WebGL cost.
 */

import { registerAppRoutePluginLoader } from "@elizaos/core";
import { vectorBrowserPlugin } from "./plugin.ts";

registerAppRoutePluginLoader(
  "@elizaos/plugin-vector-browser",
  async () => vectorBrowserPlugin,
);
