import { registerAppRoutePluginLoader } from "@elizaos/app-core/runtime/app-route-plugin-registry";

registerAppRoutePluginLoader("@elizaos/app-vincent", async () => {
  const { vincentPlugin } = await import("./plugin");
  return vincentPlugin;
});
