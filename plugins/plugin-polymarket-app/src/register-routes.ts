import { registerAppRoutePluginLoader } from "@elizaos/core/app-route-plugin-registry";

registerAppRoutePluginLoader("@elizaos/plugin-polymarket-app", async () => {
  const { polymarketPlugin } = await import("./plugin");
  return polymarketPlugin;
});
