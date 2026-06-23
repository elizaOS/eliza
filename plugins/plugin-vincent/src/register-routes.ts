import { registerAppRoutePluginLoader } from "@elizaos/core/app-route-plugin-registry";

registerAppRoutePluginLoader("@elizaos/plugin-vincent", async () => {
  const { vincentPlugin } = await import("./plugin");
  return vincentPlugin;
});
