import { registerAppRoutePluginLoader } from "@elizaos/app-core";

registerAppRoutePluginLoader("@elizaos/app-vincent", async () => {
  const { vincentPlugin } = await import("./plugin");
  return vincentPlugin;
});
