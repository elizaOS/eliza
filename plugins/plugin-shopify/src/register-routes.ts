import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-shopify", async () => {
  const { shopifyPlugin } = await import("./plugin");
  return shopifyPlugin;
});
