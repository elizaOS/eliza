/** Registers a lazy loader so app-route mounting can pull in `polymarketPlugin` on demand. */
import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-polymarket", async () => {
  const { polymarketPlugin } = await import("./plugin");
  return polymarketPlugin;
});
