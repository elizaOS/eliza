import { registerAppRoutePluginLoader } from '@elizaos/core/app-route-plugin-registry';

registerAppRoutePluginLoader('@elizaos/plugin-workflow:routes', async () => {
  const { workflowRoutePlugin } = await import('./plugin-routes');
  return workflowRoutePlugin;
});
