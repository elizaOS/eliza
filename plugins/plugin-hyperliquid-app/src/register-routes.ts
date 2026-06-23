import { registerAppRoutePluginLoader } from "@elizaos/core/app-route-plugin-registry";

registerAppRoutePluginLoader("@elizaos/plugin-hyperliquid-app", async () => {
  const { hyperliquidPlugin } = await import("./plugin");
  return hyperliquidPlugin;
});
