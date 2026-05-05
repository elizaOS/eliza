/**
 * Register the coding-agent orchestrator's HTTP routes with the
 * @elizaos/app-core route-plugin registry. The runtime walks this registry
 * during plugin initialization and mounts the rawPath routes directly onto
 * the agent runtime.
 */

async function registerCodingAgentRoutePluginLoader(): Promise<void> {
  try {
    const { registerAppRoutePluginLoader } = await import(
      "@elizaos/app-core/runtime/app-route-plugin-registry"
    );
    registerAppRoutePluginLoader(
      "@elizaos/plugin-agent-orchestrator",
      async () => {
        const { codingAgentRoutePlugin } = await import("./setup-routes.js");
        return codingAgentRoutePlugin;
      },
    );
  } catch {
    // Older app-core package metadata does not expose the route-plugin registry.
    // In that case the legacy server.ts dispatch path still serves these routes.
  }
}

void registerCodingAgentRoutePluginLoader();
