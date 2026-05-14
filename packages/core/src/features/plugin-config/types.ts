/**
 * Plugin-config primitives — shared types.
 *
 * The planner uses these atomic actions to answer "what does this plugin
 * need to be activated?" and to orchestrate filling the gaps. Cloud-backed
 * surfaces (manifest registries, plugin loaders) live outside core; the
 * actions resolve them via `runtime.getService(...)` and degrade gracefully
 * when absent.
 */

import type { Plugin } from "../../types/index.ts";

/** Service-name constant for the runtime-injected manifest provider. */
export const PLUGIN_MANIFEST_PROVIDER_SERVICE = "PluginManifestProvider";
/** Service-name constant for the runtime-injected plugin loader. */
export const PLUGIN_LOADER_SERVICE = "PluginLoader";

/**
 * Minimal manifest shape consumed by the plugin-config actions. Subset of the
 * full PluginManifest — keeps these actions free of the heavier registry
 * machinery in app-core.
 */
export interface PluginConfigManifest {
	/** Plugin id / name as registered in the runtime registry. */
	name: string;
	/** Required secret keys — plugin will not function until all are set. */
	requiredSecrets: string[];
	/** Optional secret keys — improve behavior but not strictly required. */
	optionalSecrets: string[];
}

/**
 * Cloud / app-core backed manifest provider. Resolved via
 * `runtime.getService(PLUGIN_MANIFEST_PROVIDER_SERVICE)`. Implementations read
 * from the registry entries (e.g., `packages/app-core/src/registry`).
 */
export interface PluginManifestProvider {
	getManifest(pluginName: string): PluginConfigManifest | null;
}

/**
 * Plugin loader for ACTIVATE_PLUGIN_IF_READY. Resolved via
 * `runtime.getService(PLUGIN_LOADER_SERVICE)`. Returns the constructed Plugin
 * instance (e.g., from `import("@elizaos/plugin-...")`).
 */
export interface PluginLoader {
	load(pluginName: string): Promise<Plugin | null>;
}

/** Result shape for PROBE_PLUGIN_CONFIG_REQUIREMENTS. */
export interface ProbePluginConfigResult {
	pluginName: string;
	required: string[];
	optional: string[];
	present: string[];
	missing: string[];
	ready: boolean;
}

/** Per-plugin completeness summary used by the planner provider. */
export interface PluginCompleteness {
	name: string;
	ready: boolean;
	missing: string[];
}

/** Event name emitted by ACTIVATE_PLUGIN_IF_READY when activation succeeds. */
export const PLUGIN_ACTIVATED_EVENT = "PluginActivated";
