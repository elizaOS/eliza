import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/app-vincent", async () => {
  const { vincentPlugin } = await import("./plugin");
  return vincentPlugin;
});
