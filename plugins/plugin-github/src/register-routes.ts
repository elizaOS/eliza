import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-github", async () => {
  const { githubPlugin } = await import("./index.js");
  return githubPlugin;
});
