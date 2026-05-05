import { registerAppRoutePluginLoader } from "@elizaos/app-core/runtime/app-route-plugin-registry";

registerAppRoutePluginLoader("@elizaos/plugin-elizacloud:routes", async () => {
  const { elizaCloudRoutePlugin } = await import("./plugin");
  return elizaCloudRoutePlugin;
});
