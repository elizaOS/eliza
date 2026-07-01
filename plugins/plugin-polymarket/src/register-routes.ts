import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-polymarket", async () => {
  const { polymarketPlugin } = await import("./plugin");
  return polymarketPlugin;
});
