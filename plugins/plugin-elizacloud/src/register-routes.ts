import { registerAppRoutePluginLoader } from "@elizaos/core/api/app-route-plugin-registry";

registerAppRoutePluginLoader("@elizaos/plugin-elizacloud:routes", async () => {
  const { elizaCloudRoutePlugin } = await import("./plugin");
  return elizaCloudRoutePlugin;
});
