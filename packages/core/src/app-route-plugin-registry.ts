import type { Plugin } from "./types/plugin";

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
