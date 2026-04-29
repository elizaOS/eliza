import { registerAppRoutePluginLoader } from "@elizaos/app-core";

registerAppRoutePluginLoader("@elizaos/app-polymarket", async () => {
  const { polymarketPlugin } = await import("./plugin");
  return polymarketPlugin;
});
