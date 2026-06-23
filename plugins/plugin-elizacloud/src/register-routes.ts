import { registerAppRoutePluginLoader } from "@elizaos/core/app-route-plugin-registry";

registerAppRoutePluginLoader("@elizaos/plugin-elizacloud:routes", async () => {
  const { elizaCloudRoutePlugin } = await import("./plugin");
  return elizaCloudRoutePlugin;
});
