import { registerAppRoutePluginLoader } from "@elizaos/app-core";

registerAppRoutePluginLoader("@elizaos/app-steward", async () => {
  const { stewardPlugin } = await import("./plugin");
  return stewardPlugin;
});
