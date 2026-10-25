import { registerAppRoutePluginLoader } from "@elizaos/host/protocol";

registerAppRoutePluginLoader("@elizaos/plugin-elizacloud:routes", async () => {
  const { elizaCloudRoutePlugin } = await import("./plugin");
  return elizaCloudRoutePlugin;
});
