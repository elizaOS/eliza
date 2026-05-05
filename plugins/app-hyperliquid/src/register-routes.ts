import { registerAppRoutePluginLoader } from "@elizaos/app-core";

registerAppRoutePluginLoader("@elizaos/app-hyperliquid", async () => {
  const { hyperliquidPlugin } = await import("./plugin");
  return hyperliquidPlugin;
});
