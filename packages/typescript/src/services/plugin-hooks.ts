/**
 * Plugin Startup Hooks
 *
 * Provides a system for registering hooks that run during plugin initialization.
 * This allows external systems (like Otto) to participate in plugin loading.
 *
 * @module services/plugin-hooks
 */

import type { Character } from "../types/agent.ts";
import type { Plugin } from "../types/plugin.ts";

/**
 * Context provided to plugin startup hooks.
 */
export interface PluginHookContext {
	/** The character configuration */
	character: Character;
	/** Environment variables */
	env: NodeJS.ProcessEnv;
	/** Plugins that will be registered */
	plugins: Plugin[];
}

/**
 * Result from a plugin filter hook.
 */
export interface PluginFilterResult {
	/** Filtered list of plugins */
	plugins: Plugin[];
	/** Changes made during filtering */
	changes: string[];
}

/**
 * Hook function type for pre-registration plugins.
 */
export type PluginPreRegisterHook = (
	context: PluginHookContext,
) => Promise<PluginFilterResult> | PluginFilterResult;

/**
 * Hook function type for post-registration.
 */
export type PluginPostRegisterHook = (
	context: PluginHookContext,
) => Promise<void> | void;

/**
 * Configuration for plugin allow/deny filtering.
 */
export interface PluginFilterConfig {
	/** List of plugin names to allow (whitelist) */
	allow?: string[];
	/** List of plugin names to deny (blacklist) */
	deny?: string[];
}

// Global hook registries
const preRegisterHooks: PluginPreRegisterHook[] = [];
const postRegisterHooks: PluginPostRegisterHook[] = [];

/**
 * Register a hook that runs before plugins are registered.
 * The hook can modify the list of plugins that will be registered.
 *
 * @param hook - The hook function to register
 * @returns A function to unregister the hook
 */
export function registerPreRegisterHook(
	hook: PluginPreRegisterHook,
): () => void {
	preRegisterHooks.push(hook);
	return () => {
		const index = preRegisterHooks.indexOf(hook);
		if (index !== -1) {
			preRegisterHooks.splice(index, 1);
		}
	};
}

/**
 * Register a hook that runs after plugins are registered.
 *
 * @param hook - The hook function to register
 * @returns A function to unregister the hook
 */
export function registerPostRegisterHook(
	hook: PluginPostRegisterHook,
): () => void {
	postRegisterHooks.push(hook);
	return () => {
		const index = postRegisterHooks.indexOf(hook);
		if (index !== -1) {
			postRegisterHooks.splice(index, 1);
		}
	};
}

/**
 * Run all pre-register hooks and return the filtered plugins.
 *
 * @param context - The plugin hook context
 * @returns The filtered plugins and all changes made
 */
export async function runPreRegisterHooks(
	context: PluginHookContext,
): Promise<PluginFilterResult> {
	let currentPlugins = [...context.plugins];
	const allChanges: string[] = [];

	for (const hook of preRegisterHooks) {
		const result = await hook({ ...context, plugins: currentPlugins });
		currentPlugins = result.plugins;
		allChanges.push(...result.changes);
	}

	return { plugins: currentPlugins, changes: allChanges };
}

/**
 * Run all post-register hooks.
 *
 * @param context - The plugin hook context
 */
export async function runPostRegisterHooks(
	context: PluginHookContext,
): Promise<void> {
	for (const hook of postRegisterHooks) {
		await hook(context);
	}
}

/**
 * Apply allow/deny filtering to a list of plugins.
 *
 * The filtering logic:
 * - If `allow` is specified, only plugins in the allow list are kept
 * - If `deny` is specified, plugins in the deny list are removed
 * - Both can be specified: allow is applied first, then deny
 *
 * Plugin names are matched case-insensitively and support:
 * - Full plugin name: "@elizaos/plugin-discord"
 * - Short name: "discord" (matches "@elizaos/plugin-discord")
 *
 * @param plugins - The list of plugins to filter
 * @param config - The filter configuration
 * @returns The filtered list of plugins and changes made
 */
export function applyPluginFilter(
	plugins: Plugin[],
	config: PluginFilterConfig,
): PluginFilterResult {
	const changes: string[] = [];
	let filteredPlugins = [...plugins];

	// Normalize a plugin name for comparison
	const normalizePluginName = (name: string): string => {
		const lower = name.toLowerCase().trim();
		const safeLower = lower.length > 256 ? lower.slice(0, 256) : lower;
		// Extract short name from full package name
		const match = safeLower.match(/@[^/]+\/plugin-(.+)$/);
		return match ? match[1] : safeLower;
	};

	// Check if a plugin matches any name in a list
	const matchesAny = (plugin: Plugin, names: string[]): boolean => {
		const pluginName = plugin.name.toLowerCase();
		const pluginShortName = normalizePluginName(plugin.name);

		return names.some((name) => {
			const normalizedName = normalizePluginName(name);
			return (
				pluginName === name.toLowerCase() ||
				pluginShortName === normalizedName ||
				pluginName.includes(normalizedName)
			);
		});
	};

	// Apply allow list (whitelist)
	if (config.allow && config.allow.length > 0) {
		const allowedNames = config.allow;
		const beforeCount = filteredPlugins.length;

		filteredPlugins = filteredPlugins.filter((plugin) => {
			const isAllowed = matchesAny(plugin, allowedNames);
			if (!isAllowed) {
				changes.push(`Filtered out plugin (not in allow list): ${plugin.name}`);
			}
			return isAllowed;
		});

		if (beforeCount !== filteredPlugins.length) {
			changes.push(
				`Allow list filter: ${beforeCount} → ${filteredPlugins.length} plugins`,
			);
		}
	}

	// Apply deny list (blacklist)
	if (config.deny && config.deny.length > 0) {
		const deniedNames = config.deny;

		filteredPlugins = filteredPlugins.filter((plugin) => {
			const isDenied = matchesAny(plugin, deniedNames);
			if (isDenied) {
				changes.push(`Filtered out plugin (in deny list): ${plugin.name}`);
			}
			return !isDenied;
		});
	}

	return { plugins: filteredPlugins, changes };
}

/**
 * Create a pre-register hook that applies allow/deny filtering.
 *
 * @param config - The filter configuration
 * @returns A pre-register hook function
 */
export function createPluginFilterHook(
	config: PluginFilterConfig,
): PluginPreRegisterHook {
	return (context: PluginHookContext): PluginFilterResult => {
		return applyPluginFilter(context.plugins, config);
	};
}

/**
 * Get the current number of registered pre-register hooks.
 */
export function getPreRegisterHookCount(): number {
	return preRegisterHooks.length;
}

/**
 * Get the current number of registered post-register hooks.
 */
export function getPostRegisterHookCount(): number {
	return postRegisterHooks.length;
}

/**
 * Clear all registered hooks. Useful for testing.
 */
export function clearAllHooks(): void {
	preRegisterHooks.length = 0;
	postRegisterHooks.length = 0;
}
