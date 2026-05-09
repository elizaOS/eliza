import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-elizacloud:routes", async () => {
  const { elizaCloudRoutePlugin } = await import("./plugin");
  return elizaCloudRoutePlugin;
});
