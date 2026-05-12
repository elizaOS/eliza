/**
 * @module features/plugin-manager/actions/plugin-handlers/runtime-state
 *
 * Read and mutate runtime plugin state for the unified MANAGE_PLUGINS action.
 */

import type {
	ActionResult,
	HandlerCallback,
} from "../../../../types/components.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { PluginManagerService } from "../../services/pluginManagerService.ts";
import {
	type EjectedPluginInfo,
	type PluginState,
	PluginStatus,
} from "../../types.ts";

interface RuntimeStateInput {
	runtime: IAgentRuntime;
	name?: string;
	callback?: HandlerCallback;
}

function getPluginManager(runtime: IAgentRuntime): PluginManagerService | null {
	return runtime.getService("plugin_manager") as PluginManagerService | null;
}

function normalizeName(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/^@elizaos\//, "")
		.replace(/^plugin-/, "");
}

function matchesPluginName(candidate: string, requested: string): boolean {
	const normalizedCandidate = normalizeName(candidate);
	const normalizedRequested = normalizeName(requested);
	return (
		candidate === requested ||
		normalizedCandidate === normalizedRequested ||
		normalizedCandidate === normalizeName(`plugin-${requested}`) ||
		candidate === `@elizaos/${requested}` ||
		candidate === `@elizaos/plugin-${requested}` ||
		candidate.endsWith(`/${requested}`) ||
		candidate.endsWith(`/plugin-${requested}`)
	);
}

function findPluginState(
	service: PluginManagerService,
	nameOrId: string,
): PluginState | undefined {
	return service
		.getAllPlugins()
		.find(
			(plugin) =>
				plugin.id === nameOrId || matchesPluginName(plugin.name, nameOrId),
		);
}

function findPluginInfo(
	plugins: EjectedPluginInfo[],
	name: string,
): EjectedPluginInfo | undefined {
	return plugins.find((plugin) => matchesPluginName(plugin.name, name));
}

function summarizePluginState(plugin: PluginState): string {
	const parts = [`${plugin.name} [${plugin.status}]`];
	if (plugin.loadedAt) {
		parts.push(`loaded=${new Date(plugin.loadedAt).toISOString()}`);
	}
	if (plugin.unloadedAt) {
		parts.push(`unloaded=${new Date(plugin.unloadedAt).toISOString()}`);
	}
	if (plugin.error) parts.push(`error=${plugin.error}`);
	return parts.join(" ");
}

export async function runPluginStatus({
	runtime,
	name,
	callback,
}: RuntimeStateInput): Promise<ActionResult> {
	const service = getPluginManager(runtime);
	if (!service) {
		const text = "Plugin manager service not available";
		await callback?.({ text });
		return { success: false, text };
	}

	const all = service.getAllPlugins();
	const installed = await service.listInstalledPlugins();
	const ejected = await service.listEjectedPlugins();

	if (name) {
		const state = findPluginState(service, name);
		const installedInfo = findPluginInfo(installed, name);
		const ejectedInfo = findPluginInfo(ejected, name);

		if (!state && !installedInfo && !ejectedInfo) {
			const text = `No plugin state found for ${name}.`;
			await callback?.({ text });
			return {
				success: false,
				text,
				values: { mode: "status", name, found: false },
			};
		}

		const lines = [
			`Plugin status for ${state?.name ?? installedInfo?.name ?? ejectedInfo?.name ?? name}:`,
		];
		lines.push(
			state
				? `  runtime: ${summarizePluginState(state)}`
				: "  runtime: not registered",
		);
		lines.push(
			installedInfo
				? `  installed: yes (v${installedInfo.version}) at ${installedInfo.path}`
				: "  installed: no managed install found",
		);
		lines.push(
			ejectedInfo
				? `  ejected: yes (v${ejectedInfo.version}) at ${ejectedInfo.path}`
				: "  ejected: no",
		);

		const text = lines.join("\n");
		await callback?.({ text });
		return {
			success: true,
			text,
			values: {
				mode: "status",
				name,
				found: true,
				runtimeStatus: state?.status,
				installed: Boolean(installedInfo),
				ejected: Boolean(ejectedInfo),
			},
			data: { state, installed: installedInfo, ejected: ejectedInfo },
		};
	}

	const loadedCount = all.filter(
		(plugin) => plugin.status === PluginStatus.LOADED,
	).length;
	const readyCount = all.filter(
		(plugin) => plugin.status === PluginStatus.READY,
	).length;
	const unloadedCount = all.filter(
		(plugin) => plugin.status === PluginStatus.UNLOADED,
	).length;
	const errorCount = all.filter(
		(plugin) => plugin.status === PluginStatus.ERROR,
	).length;
	const text = [
		"Plugin status:",
		`  runtime total: ${all.length}`,
		`  loaded: ${loadedCount}`,
		`  ready: ${readyCount}`,
		`  unloaded: ${unloadedCount}`,
		`  errors: ${errorCount}`,
		`  managed installs: ${installed.length}`,
		`  ejected: ${ejected.length}`,
	].join("\n");
	await callback?.({ text });
	return {
		success: true,
		text,
		values: {
			mode: "status",
			totalPlugins: all.length,
			loadedCount,
			readyCount,
			unloadedCount,
			errorCount,
			installedCount: installed.length,
			ejectedCount: ejected.length,
		},
		data: { plugins: all, installed, ejected },
	};
}

export async function runPluginDetails({
	runtime,
	name,
	callback,
}: RuntimeStateInput): Promise<ActionResult> {
	const service = getPluginManager(runtime);
	if (!service) {
		const text = "Plugin manager service not available";
		await callback?.({ text });
		return { success: false, text };
	}
	if (!name) {
		const text = "Specify a plugin name for details.";
		await callback?.({ text });
		return { success: false, text };
	}

	const state = findPluginState(service, name);
	const registry = await service.getRegistryPlugin(name);

	if (!state && !registry) {
		const text = `Plugin "${name}" not found in runtime state or registry.`;
		await callback?.({ text });
		return { success: false, text, values: { mode: "details", name } };
	}

	const lines: string[] = [];
	if (registry) {
		lines.push(`${registry.name}`);
		if (registry.description)
			lines.push(`Description: ${registry.description}`);
		const version =
			registry.npm.v2Version ||
			registry.npm.v1Version ||
			registry.npm.v0Version;
		if (version) lines.push(`Version: ${version}`);
		if (registry.gitRepo)
			lines.push(`Repository: https://github.com/${registry.gitRepo}`);
		if (registry.topics.length > 0) {
			lines.push(`Tags: ${registry.topics.slice(0, 8).join(", ")}`);
		}
	}
	if (state) {
		if (lines.length > 0) lines.push("");
		lines.push(`Runtime: ${summarizePluginState(state)}`);
	}

	const text = lines.join("\n");
	await callback?.({ text });
	return {
		success: true,
		text,
		values: {
			mode: "details",
			name: registry?.name ?? state?.name ?? name,
			runtimeStatus: state?.status,
			registryFound: Boolean(registry),
		},
		data: { state, registry },
	};
}

async function setPluginEnabled({
	runtime,
	name,
	callback,
	enabled,
}: RuntimeStateInput & { enabled: boolean }): Promise<ActionResult> {
	const service = getPluginManager(runtime);
	if (!service) {
		const text = "Plugin manager service not available";
		await callback?.({ text });
		return { success: false, text };
	}
	if (!name) {
		const text = `Specify a plugin name to ${enabled ? "enable" : "disable"}.`;
		await callback?.({ text });
		return { success: false, text };
	}

	const state = findPluginState(service, name);
	if (!state) {
		const text = `Plugin "${name}" is not registered in the current runtime.`;
		await callback?.({ text });
		return { success: false, text, values: { name, enabled } };
	}

	try {
		if (enabled) {
			await service.loadPlugin({ pluginId: state.id });
		} else {
			await service.unloadPlugin({ pluginId: state.id });
		}
		const updated = service.getPlugin(state.id);
		const text = `Plugin ${state.name} ${enabled ? "enabled" : "disabled"} (${updated?.status ?? state.status}).`;
		await callback?.({ text });
		return {
			success: true,
			text,
			values: {
				mode: enabled ? "enable" : "disable",
				name: state.name,
				status: updated?.status ?? state.status,
			},
			data: { plugin: updated ?? state },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const text = `Failed to ${enabled ? "enable" : "disable"} ${state.name}: ${message}`;
		await callback?.({ text });
		return {
			success: false,
			text,
			error: message,
			values: { name: state.name, enabled },
		};
	}
}

export async function runEnablePlugin(
	input: RuntimeStateInput,
): Promise<ActionResult> {
	return setPluginEnabled({ ...input, enabled: true });
}

export async function runDisablePlugin(
	input: RuntimeStateInput,
): Promise<ActionResult> {
	return setPluginEnabled({ ...input, enabled: false });
}
