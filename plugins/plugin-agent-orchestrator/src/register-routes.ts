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

// Fire registration. Stored on a const so a bundler that walks the
// module ESM graph can see this as a value-producing top-level
// statement rather than a discardable expression statement.
const _codingAgentRouteRegistrationPromise =
  registerCodingAgentRoutePluginLoader();

/**
 * Sentinel re-exported by `src/index.ts` so bundlers that aggressively
 * tree-shake side-effect-only imports cannot drop this module. The
 * value is a Promise that resolves once the route loader has been
 * registered; callers that need to await registration completion (e.g.
 * tests) may chain on it, but the typical caller only needs the import
 * to fire.
 */
export const codingAgentRouteRegistration: Promise<void> =
  _codingAgentRouteRegistrationPromise;
