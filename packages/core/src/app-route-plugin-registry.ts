import { logger } from "./logger";
import type { Plugin, Route } from "./types/plugin";

export type AppRoutePluginLoader = () => Plugin | Promise<Plugin>;

export interface AppRoutePluginRegistryEntry {
	id: string;
	load: AppRoutePluginLoader;
}

interface AppRoutePluginRegistryStore {
	entries: Map<string, AppRoutePluginRegistryEntry>;
}

const APP_ROUTE_PLUGIN_REGISTRY_KEY = Symbol.for(
	"elizaos.app.route-plugin-registry",
);

function getRegistryStore(): AppRoutePluginRegistryStore {
	const globalObject = globalThis as Record<PropertyKey, unknown>;
	const existing = globalObject[APP_ROUTE_PLUGIN_REGISTRY_KEY] as
		| AppRoutePluginRegistryStore
		| null
		| undefined;
	if (existing) {
		return existing;
	}

	const created: AppRoutePluginRegistryStore = {
		entries: new Map<string, AppRoutePluginRegistryEntry>(),
	};
	globalObject[APP_ROUTE_PLUGIN_REGISTRY_KEY] = created;
	return created;
}

export function registerAppRoutePluginLoader(
	id: string,
	load: AppRoutePluginLoader,
): void {
	getRegistryStore().entries.set(id, { id, load });
}

export function listAppRoutePluginLoaders(): AppRoutePluginRegistryEntry[] {
	return [...getRegistryStore().entries.values()];
}

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
 * so `tryHandleRuntimePluginRoute` matches them. Per-loader failures are
 * isolated: an optional-unavailable loader is debug-logged and contributes no
 * routes; any other failure is warn-logged and skipped, never aborting the rest.
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
				// intentionally absent in this deployment; identify it by name to
				// avoid a dependency on the app-core error class.
				if (
					err instanceof Error &&
					err.name === "OptionalAppRoutePluginUnavailableError"
				) {
					logger.debug(
						`[app-routes] App route plugin ${id} unavailable, skipping route registration`,
					);
					return null;
				}
				logger.warn(
					`[app-routes] Failed to register app route plugin ${id}: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
				return null;
			}
		}),
	);
	const existing = new Set(target.routes.map((r) => `${r.type}:${r.path}`));
	for (const plugin of loaded) {
		if (!plugin?.routes?.length) continue;
		let added = 0;
		for (const route of plugin.routes) {
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
