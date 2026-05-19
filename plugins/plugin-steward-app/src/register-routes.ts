import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-steward-app", async () => {
  const { stewardPlugin } = await import("./plugin");
  return stewardPlugin;
});
