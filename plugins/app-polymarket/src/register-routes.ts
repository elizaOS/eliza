import { registerAppRoutePluginLoader } from "@elizaos/app-core/runtime/app-route-plugin-registry";

registerAppRoutePluginLoader("@elizaos/app-polymarket", async () => {
  const { polymarketPlugin } = await import("./plugin");
  return polymarketPlugin;
});
