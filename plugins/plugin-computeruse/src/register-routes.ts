import { registerAppRoutePluginLoader } from "@elizaos/app-core/runtime/app-route-plugin-registry";

registerAppRoutePluginLoader("@elizaos/plugin-computeruse", async () => {
  const { computerUsePlugin } = await import("./index.js");
  return computerUsePlugin;
});
