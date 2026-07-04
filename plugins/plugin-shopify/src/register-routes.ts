/**
 * Registers a lazy loader for the Shopify route/views plugin with the app-route
 * plugin system, so `./plugin` (and its `/api/shopify/*` routes) is imported
 * only when the app route host asks for it.
 */
import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-shopify", async () => {
  const { shopifyPlugin } = await import("./plugin");
  return shopifyPlugin;
});
