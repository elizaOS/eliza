import { registerAppRoutePluginLoader } from '@elizaos/core';

registerAppRoutePluginLoader('@elizaos/plugin-workflow:routes', async () => {
  const { workflowRoutePlugin } = await import('./plugin-routes');
  return workflowRoutePlugin;
});
