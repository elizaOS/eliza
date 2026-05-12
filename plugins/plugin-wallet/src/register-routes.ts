/**
 * Side-effect import: registers the @elizaos/plugin-wallet route plugin
 * with the runtime app-route plugin registry. Imported by the API server
 * at startup so wallet HTTP routes are dispatched via Plugin.routes.
 */
import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-wallet:routes", async () => {
  const { walletRoutePlugin } = await import("./routes/plugin");
  return walletRoutePlugin;
});
