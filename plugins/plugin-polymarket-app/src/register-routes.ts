import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-polymarket-app", async () => {
  const { polymarketPlugin } = await import("./plugin");
  return polymarketPlugin;
});
