/** Side-effect module: registers a lazy loader so the app route layer can load `hyperliquidPlugin` opt-in without a static import. */
import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-hyperliquid", async () => {
  const { hyperliquidPlugin } = await import("./plugin");
  return hyperliquidPlugin;
});
