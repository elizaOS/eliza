/**
 * Register the coding-agent orchestrator's HTTP routes with the
 * @elizaos/core route-plugin registry. The runtime walks this registry
 * during plugin initialization and mounts the rawPath routes directly onto
 * the agent runtime.
 *
 * No-op under store builds — the routes drive spawn/control surfaces that
 * are unavailable when local code execution is disabled.
 */

import { isLocalCodeExecutionAllowed } from "@elizaos/core";

async function registerCodingAgentRoutePluginLoader(): Promise<void> {
  if (!isLocalCodeExecutionAllowed()) return;
  const { registerAppRoutePluginLoader } = await import("@elizaos/core");
  registerAppRoutePluginLoader(
    "@elizaos/plugin-agent-orchestrator",
    async () => {
      const { codingAgentRoutePlugin } = await import("./setup-routes.js");
      return codingAgentRoutePlugin;
    },
  );
}

void registerCodingAgentRoutePluginLoader();
