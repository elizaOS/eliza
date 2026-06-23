import { registerAppRoutePluginLoader } from "@elizaos/core/app-route-plugin-registry";

registerAppRoutePluginLoader("@elizaos/plugin-github", async () => {
  const { githubPlugin } = await import("./index.js");
  return githubPlugin;
});
