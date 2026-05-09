/**
 * Register the coding-agent orchestrator's HTTP routes with the
 * @elizaos/app-core route-plugin registry. The runtime walks this registry
 * during plugin initialization and mounts the rawPath routes directly onto
 * the agent runtime.
 */

async function registerCodingAgentRoutePluginLoader(): Promise<void> {
  try {
    const { registerAppRoutePluginLoader } = await import("@elizaos/core");
    registerAppRoutePluginLoader(
      "@elizaos/plugin-agent-orchestrator",
      async () => {
        const { codingAgentRoutePlugin } = await import("./setup-routes.js");
        return codingAgentRoutePlugin;
      },
    );
  } catch {}
}

void registerCodingAgentRoutePluginLoader();
