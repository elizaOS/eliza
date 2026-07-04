/**
 * Registers the plugin's HTTP routes with app-core's lazy route loader, importing
 * the plugin only when a computer-use route is first hit.
 */
import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader("@elizaos/plugin-computeruse", async () => {
  const { computerUsePlugin } = await import("./index.js");
  return computerUsePlugin;
});
