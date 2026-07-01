import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-hyperliquid", async () => {
  const { hyperliquidPlugin } = await import("./plugin");
  return hyperliquidPlugin;
});
