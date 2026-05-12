import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/app-hyperliquid", async () => {
  const { hyperliquidPlugin } = await import("./plugin");
  return hyperliquidPlugin;
});
