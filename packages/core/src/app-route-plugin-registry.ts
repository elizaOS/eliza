/**
 * Registry and drain logic for app-route plugins — plugins that expose HTTP
 * routes but register a loader here (keyed by id) instead of via `Plugin.routes`
 * so a bundler cannot tree-shake them away. {@link drainAppRoutePluginLoaders}
 * pulls the loaded plugins' routes onto a runtime's route table idempotently
 * (keyed by `${type}:${path}`), tolerating both the `@elizaos/agent` and
 * `@elizaos/app-core` boots draining against the same table. Also owns the
 * optional-unavailable error contract (matched by `Error.name`, not
 * `instanceof`) so an intentionally-absent optional plugin is a graceful skip
 * even across duplicate `@elizaos/core` bundles.
 */
import { getAmbientSingleton } from "./ambient-context";
import { logger } from "./logger";
import {
	assertPublicRouteIntent,
	type Plugin,
	type Route,
} from "./types/plugin";

export type AppRoutePluginLoader = () => Plugin | Promise<Plugin>;

export interface AppRoutePluginRegistryEntry {
	id: string;
	load: AppRoutePluginLoader;
}

/**
 * Canonical `Error.name` for the error an app-route plugin loader throws when
 * its plugin is intentionally absent from this deployment (optional plugin).
 *
 * This single string literal is the whole cross-package contract: hosts
 * (`@elizaos/app-core`) construct {@link OptionalAppRoutePluginUnavailableError}
 * and {@link drainAppRoutePluginLoaders} recognizes it. Matching is by name (not
 * `instanceof`) so it stays robust when a combined deployment bundles two copies
 * of `@elizaos/core` — the class identity differs across bundles but the name
 * does not.
 */
export const OPTIONAL_APP_ROUTE_PLUGIN_UNAVAILABLE_ERROR_NAME =
	"OptionalAppRoutePluginUnavailableError";

/**
 * Error an app-route plugin loader throws when its optional plugin is not
 * installed in this deployment. Hosts throw it; {@link drainAppRoutePluginLoaders}
 * treats it as a graceful skip. Owned by core so the contract has one definition.
 */
export class OptionalAppRoutePluginUnavailableError extends Error {
	readonly specifier: string;

	constructor(specifier: string, cause?: unknown) {
		super(`Optional app route plugin ${specifier} is unavailable`, { cause });
		this.name = OPTIONAL_APP_ROUTE_PLUGIN_UNAVAILABLE_ERROR_NAME;
		this.specifier = specifier;
	}
}

/**
 * Whether `err` is the optional-app-route-plugin-unavailable signal. Matches by
 * `Error.name` (not `instanceof`) so it holds across duplicate `@elizaos/core`
 * bundles in a combined deployment.
 */
export function isOptionalAppRoutePluginUnavailableError(
	err: unknown,
): boolean {
	return (
		err instanceof Error &&
		err.name === OPTIONAL_APP_ROUTE_PLUGIN_UNAVAILABLE_ERROR_NAME
	);
}

interface AppRoutePluginRegistryStore {
	entries: Map<string, AppRoutePluginRegistryEntry>;
}

const APP_ROUTE_PLUGIN_REGISTRY_KEY = Symbol.for(
	"elizaos.app.route-plugin-registry",
);

function getRegistryStore(): AppRoutePluginRegistryStore {
	return getAmbientSingleton(APP_ROUTE_PLUGIN_REGISTRY_KEY, () => ({
		entries: new Map<string, AppRoutePluginRegistryEntry>(),
	}));
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
				// intentionally absent in this deployment.
				if (isOptionalAppRoutePluginUnavailableError(err)) {
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
