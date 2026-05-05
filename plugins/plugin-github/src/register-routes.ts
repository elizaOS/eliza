import { registerAppRoutePluginLoader } from "@elizaos/app-core/runtime/app-route-plugin-registry";

registerAppRoutePluginLoader("@elizaos/plugin-github", async () => {
  const { githubPlugin } = await import("./index.js");
  return githubPlugin;
});
