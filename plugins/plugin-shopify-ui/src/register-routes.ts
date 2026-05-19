import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-shopify-ui", async () => {
  const { shopifyPlugin } = await import("./plugin");
  return shopifyPlugin;
});
