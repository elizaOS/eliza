import { registerAppRoutePluginLoader } from "@elizaos/core/app-route-plugin-registry";

registerAppRoutePluginLoader("@elizaos/plugin-shopify-ui", async () => {
  const { shopifyPlugin } = await import("./plugin");
  return shopifyPlugin;
});
