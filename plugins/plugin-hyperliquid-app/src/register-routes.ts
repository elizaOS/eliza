import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-hyperliquid-app", async () => {
  const { hyperliquidPlugin } = await import("./plugin");
  return hyperliquidPlugin;
});
