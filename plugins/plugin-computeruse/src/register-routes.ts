import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-computeruse", async () => {
  const { computerUsePlugin } = await import("./index.js");
  return computerUsePlugin;
});
