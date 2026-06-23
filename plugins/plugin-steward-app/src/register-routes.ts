import { registerAppRoutePluginLoader } from "@elizaos/core/app-route-plugin-registry";

registerAppRoutePluginLoader("@elizaos/plugin-steward-app", async () => {
  const { stewardPlugin } = await import("./plugin");
  return stewardPlugin;
});
