/**
 * Side-effect module that registers the plugin's rawPath route plugin
 * (`@elizaos/plugin-workflow:routes`) with the app-route-plugin-registry, so the
 * host mounts the `/api/workflow/*` and `/api/automations` endpoints. `index.ts`
 * imports the exported flag to keep bundlers from dropping this registration.
 */
import { registerAppRoutePluginLoader } from '@elizaos/core';

type RegisterAppRoutePluginLoader = typeof registerAppRoutePluginLoader;

export function registerWorkflowRoutePlugin(
  register: RegisterAppRoutePluginLoader = registerAppRoutePluginLoader
): void {
  register('@elizaos/plugin-workflow:routes', async () => {
    const { workflowRoutePlugin } = await import('./plugin-routes');
    return workflowRoutePlugin;
  });
}

registerWorkflowRoutePlugin();

export const workflowRouteRegistration = true;
