/**
 * App-route plugin loader entry point: registers the full `githubPlugin`
 * (lazily imported) under `@elizaos/plugin-github` so the app-core route host
 * can mount the plugin's HTTP routes. A separate tsup entry from index.ts.
 */

import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-github", async () => {
  const { githubPlugin } = await import("./index.js");
  return githubPlugin;
});
