import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-vincent", async () => {
  const { vincentPlugin } = await import("./plugin");
  return vincentPlugin;
});
