import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/app-polymarket", async () => {
  const { polymarketPlugin } = await import("./plugin");
  return polymarketPlugin;
});
