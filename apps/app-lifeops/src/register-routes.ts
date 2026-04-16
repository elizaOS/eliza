import { registerAppRoutePluginLoader } from "@elizaos/app-core/runtime/app-route-plugin-registry";

registerAppRoutePluginLoader("@elizaos/app-lifeops", async () => {
  const { lifeopsPlugin } = await import("./routes/plugin");
  return lifeopsPlugin;
});
