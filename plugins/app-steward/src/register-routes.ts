import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/app-steward", async () => {
  const { stewardPlugin } = await import("./plugin");
  return stewardPlugin;
});
