/**
 * Register the coding-agent orchestrator's HTTP routes with the
 * @elizaos/core route-plugin registry. The runtime walks this registry
 * during plugin initialization and mounts the rawPath routes directly onto
 * the agent runtime.
 *
 * No-op under store builds — the routes drive spawn/control surfaces that
 * are unavailable when local code execution is disabled.
 *
 * Implementation note: the registration kick-off used to be a bare
 * top-level `void registerCodingAgentRoutePluginLoader()` call relying
 * on the importer doing `import "./register-routes.js"` as a
 * side-effect-only import. Bundlers targeting Node (Bun.build with
 * `target: "node"`) tree-shake side-effect-only imports out of the
 * final bundle when no exported symbol is referenced — which silently
 * disabled the entire `/api/coding-agents/*` route surface on the
 * node-target build. We now export a sentinel that the importing
 * module references explicitly, which forces the bundler to keep the
 * module live AND triggers the registration as a side-effect of
 * touching the sentinel.
 */

import {
  isLocalCodeExecutionAllowed,
  registerAppRoutePluginLoader,
} from "@elizaos/core";

function registerCodingAgentRoutePluginLoader(): void {
  if (!isLocalCodeExecutionAllowed()) return;
  registerAppRoutePluginLoader(
    "@elizaos/plugin-agent-orchestrator:routes",
    async () => {
      const { codingAgentRoutePlugin } = await import("./setup-routes.js");
      return codingAgentRoutePlugin;
    },
  );
}

// Fire registration. Stored on a const so a bundler that walks the
// module ESM graph can see this as a value-producing top-level
// statement rather than a discardable expression statement.
registerCodingAgentRoutePluginLoader();

/**
 * Sentinel re-exported by `src/index.ts` so bundlers that aggressively
 * tree-shake side-effect-only imports cannot drop this module. The
 * value is true once the module has evaluated. The registration itself is
 * synchronous so app-core's loader snapshot cannot race the route registration.
 */
export const codingAgentRouteRegistration = true;
