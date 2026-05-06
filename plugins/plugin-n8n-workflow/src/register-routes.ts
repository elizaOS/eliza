import { registerAppRoutePluginLoader } from "@elizaos/app-core/runtime/app-route-plugin-registry";

<<<<<<< HEAD
registerAppRoutePluginLoader(
  "@elizaos/plugin-n8n-workflow:routes",
  async () => {
    const { n8nWorkflowRoutePlugin } = await import("./plugin-routes");
    return n8nWorkflowRoutePlugin;
  },
);
=======
registerAppRoutePluginLoader('@elizaos/plugin-n8n-workflow:routes', async () => {
  const { n8nWorkflowRoutePlugin } = await import('./plugin-routes');
  return n8nWorkflowRoutePlugin;
});
>>>>>>> pr-7399
