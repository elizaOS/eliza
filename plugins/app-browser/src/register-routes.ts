import { registerAppRoutePluginLoader } from "@elizaos/app-core/runtime/app-route-plugin-registry";

registerAppRoutePluginLoader("@elizaos/app-browser", async () => {
  const { browserWorkspaceRoutePlugin } = await import("./setup-routes.js");
  return browserWorkspaceRoutePlugin;
});
