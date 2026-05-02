import { registerAppRoutePluginLoader } from "@elizaos/app-core";

registerAppRoutePluginLoader("@elizaos/app-shopify", async () => {
  const { shopifyPlugin } = await import("./plugin");
  return shopifyPlugin;
});
