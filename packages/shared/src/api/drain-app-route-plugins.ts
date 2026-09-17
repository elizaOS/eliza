import { assertPublicRouteIntent, logger, type Route } from "@elizaos/core";
import {
  type AppRoutePluginRegistryEntry,
  isOptionalAppRoutePluginUnavailableError,
  listAppRoutePluginLoaders,
} from "./app-route-plugin-registry.js";

/**
 * Drain app-route plugin loaders into a runtime's route table.
 *
 * App-route plugins register a loader here (so they survive bundler
 * tree-shaking) instead of exposing routes through `Plugin.routes` directly.
 * Both the headless `@elizaos/agent` server boot and the `@elizaos/app-core`
 * boot drain this registry; in a combined deployment (desktop/dashboard) both
 * run against the same `runtime.routes`. This helper is therefore **idempotent**:
 * routes already present (keyed by `${type}:${path}`) are skipped, so a second
 * drain adds nothing rather than double-registering hundreds of routes.
 *
 * Routes are pushed with their absolute `rawPath` (no `/<pluginName>/` prefix)
 * so `tryHandleRuntimePluginRoute` matches them. An intentionally absent
 * optional plugin contributes no routes; unexpected loader failures abort
 * registration so a broken deployment cannot appear partially healthy.
 */
export async function drainAppRoutePluginLoaders(
  target: { routes: Route[] },
  loaders: AppRoutePluginRegistryEntry[] = listAppRoutePluginLoaders(),
): Promise<void> {
  if (loaders.length === 0) return;
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
    let added = 0;
    for (const route of plugin.routes) {
      assertPublicRouteIntent(route, plugin.name);
      const routePath = route.path.startsWith("/")
        ? route.path
        : `/${route.path}`;
      const key = `${route.type}:${routePath}`;
      if (existing.has(key)) continue;
      existing.add(key);
      target.routes.push({ ...route, path: routePath });
      added += 1;
    }
    logger.info(
      `[app-routes] Registered app route plugin: ${plugin.name} (${added} routes)`,
    );
  }
}
