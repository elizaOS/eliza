import { logger } from "@elizaos/core";
import {
  type AppRoutePluginRegistryEntry,
  isOptionalAppRoutePluginUnavailableError,
  listAppRoutePluginLoaders,
} from "./app-route-plugin-registry.js";
import type { Route } from "./http-plugin";
import {
  getHttpRuntime,
  getPluginHttpRoutes,
  registerHttpPluginRoutes,
} from "./http-plugin-runtime";

/**
 * Drain app-route plugin loaders into a runtime's route table.
 *
 * App-route plugins register a loader here (so they survive bundler
 * tree-shaking) instead of exposing routes through `Plugin.routes` directly.
 * Both the headless `@elizaos/agent` server boot and the `@elizaos/app-core`
 * boot drain this registry; in a combined deployment (desktop/dashboard) both
 * run against the same HTTP host route table. This helper is therefore **idempotent**:
 * routes already present (keyed by `${type}:${path}`) are skipped, so a second
 * drain adds nothing rather than double-registering hundreds of routes.
 *
 * Routes are pushed with their absolute `rawPath` (no `/<pluginName>/` prefix)
 * so `tryHandleRuntimePluginRoute` matches them. An intentionally absent
 * optional plugin contributes no routes; unexpected loader failures abort
 * registration so a broken deployment cannot appear partially healthy.
 */
export async function drainAppRoutePluginLoaders(
  runtime: object,
  loaders: AppRoutePluginRegistryEntry[] = listAppRoutePluginLoaders(),
): Promise<void> {
  if (loaders.length === 0) return;
  const target = getHttpRuntime(runtime);
  const loaded = await Promise.all(
    loaders.map(async ({ id, load }) => {
      try {
        return await load();
      } catch (err) {
        // The optional-unavailable error is thrown by loaders whose plugin is
        // intentionally absent in this deployment.
        if (isOptionalAppRoutePluginUnavailableError(err)) {
          // error-policy:J4 optional route packages are explicitly unavailable
          // in deployments that do not install them.
          logger.debug(
            `[app-routes] App route plugin ${id} unavailable, skipping route registration`,
          );
          return null;
        }
        throw err;
      }
    }),
  );
  const existing = new Set(target.routes.map((r) => `${r.type}:${r.path}`));
  for (const plugin of loaded) {
    if (!plugin?.routes?.length) continue;
    const added: Route[] = [];
    for (const route of plugin.routes) {
      const routePath = route.path.startsWith("/")
        ? route.path
        : `/${route.path}`;
      const key = `${route.type}:${routePath}`;
      if (existing.has(key)) continue;
      existing.add(key);
      added.push({ ...route, path: routePath });
    }
    if (added.length)
      registerHttpPluginRoutes(
        runtime,
        {
          ...plugin,
          routes: [...getPluginHttpRoutes(runtime, plugin.name), ...added],
        },
        false,
      );
    logger.info(
      `[app-routes] Registered app route plugin: ${plugin.name} (${added.length} routes)`,
    );
  }
}
