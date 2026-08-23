/**
 * Exercises the runtime-state plugin handlers through their exported action
 * boundaries using deterministic in-memory plugin-manager collaborators.
 */

import { describe, expect, it } from "vitest";
import type { HandlerCallback } from "../../../../types/components.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { PluginManagerService } from "../../services/pluginManagerService.ts";
import type { RegistryPlugin } from "../../services/pluginRegistryService.ts";
import {
	type EjectedPluginInfo,
	type PluginState,
	PluginStatus,
} from "../../types.ts";
import {
	runDisablePlugin,
	runEnablePlugin,
	runPluginDetails,
	runPluginStatus,
} from "./runtime-state.ts";

const INSTALLED: EjectedPluginInfo = {
	name: "@elizaos/plugin-alpha",
	version: "2.3.4",
	path: "/plugins/alpha",
	upstream: null,
};

const EJECTED: EjectedPluginInfo = {
	name: "@elizaos/plugin-alpha",
	version: "2.3.3",
	path: "/ejected/alpha",
	upstream: null,
};

const REGISTRY: RegistryPlugin = {
	name: "@elizaos/plugin-alpha",
	gitRepo: "elizaos-plugins/plugin-alpha",
	gitUrl: "https://github.com/elizaos-plugins/plugin-alpha.git",
	description: "Alpha integration",
	homepage: null,
	topics: [
		"one",
		"two",
		"three",
		"four",
		"five",
		"six",
		"seven",
		"eight",
		"nine",
	],
	stars: 42,
	language: "TypeScript",
	npm: {
		package: "@elizaos/plugin-alpha",
		v0Version: "0.9.0",
		v1Version: "1.8.0",
		v2Version: "2.3.4",
		v0CoreRange: null,
		v1CoreRange: null,
		v2CoreRange: null,
	},
	git: { v0Branch: null, v1Branch: null, v2Branch: "main" },
	supports: { v0: true, v1: true, v2: true },
};

function pluginState(
	id: string,
	name: string,
	status: PluginStatus,
	extra: Partial<PluginState> = {},
): PluginState {
	return { id, name, status, createdAt: 1, ...extra };
}

interface ServiceOptions {
	plugins?: PluginState[];
	installed?: EjectedPluginInfo[];
	ejected?: EjectedPluginInfo[];
	registry?: RegistryPlugin | null;
	updated?: PluginState;
	loadError?: unknown;
	unloadError?: unknown;
}

function createRuntime(options: ServiceOptions | null): {
	runtime: IAgentRuntime;
	serviceNames: string[];
	loadIds: string[];
	unloadIds: string[];
	registryNames: string[];
} {
	const serviceNames: string[] = [];
	const loadIds: string[] = [];
	const unloadIds: string[] = [];
	const registryNames: string[] = [];
	const plugins = options?.plugins ?? [];
	const service = options
		? ({
				getAllPlugins: () => plugins,
				listInstalledPlugins: async () => options.installed ?? [],
				listEjectedPlugins: async () => options.ejected ?? [],
				getRegistryPlugin: async (name: string) => {
					registryNames.push(name);
					return options.registry ?? null;
				},
				loadPlugin: async ({ pluginId }: { pluginId: string }) => {
					loadIds.push(pluginId);
					if ("loadError" in options) throw options.loadError;
				},
				unloadPlugin: async ({ pluginId }: { pluginId: string }) => {
					unloadIds.push(pluginId);
					if ("unloadError" in options) throw options.unloadError;
				},
				getPlugin: (id: string) =>
					options.updated ?? plugins.find((plugin) => plugin.id === id),
			} as unknown as PluginManagerService)
		: null;

	return {
		runtime: {
			getService: (name: string) => {
				serviceNames.push(name);
				return service;
			},
		} as unknown as IAgentRuntime,
		serviceNames,
		loadIds,
		unloadIds,
		registryNames,
	};
}

function createCallback(): { callback: HandlerCallback; replies: string[] } {
	const replies: string[] = [];
	return {
		callback: async (content) => {
			if (typeof content.text === "string") replies.push(content.text);
			return [];
		},
		replies,
	};
}

describe("runPluginStatus", () => {
	it("reports an unavailable plugin manager through the callback", async () => {
		const { runtime, serviceNames } = createRuntime(null);
		const { callback, replies } = createCallback();

		const result = await runPluginStatus({ runtime, callback });

		expect(result).toEqual({
			success: false,
			text: "Plugin manager service not available",
		});
		expect(serviceNames).toEqual(["plugin_manager"]);
		expect(replies).toEqual(["Plugin manager service not available"]);
	});

	it("counts every runtime status and preserves complete service data", async () => {
		const plugins = [
			pluginState("loaded-1", "plugin-loaded-one", PluginStatus.LOADED),
			pluginState("ready", "plugin-ready", PluginStatus.READY),
			pluginState("unloaded", "plugin-unloaded", PluginStatus.UNLOADED),
			pluginState("error", "plugin-error", PluginStatus.ERROR),
			pluginState("loaded-2", "plugin-loaded-two", PluginStatus.LOADED),
		];
		const { runtime } = createRuntime({
			plugins,
			installed: [INSTALLED],
			ejected: [EJECTED],
		});
		const { callback, replies } = createCallback();

		const result = await runPluginStatus({ runtime, callback });

		const text = [
			"Plugin status:",
			"  runtime total: 5",
			"  loaded: 2",
			"  ready: 1",
			"  unloaded: 1",
			"  errors: 1",
			"  managed installs: 1",
			"  ejected: 1",
		].join("\n");
		expect(result).toEqual({
			success: true,
			text,
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			values: {
				mode: "status",
				totalPlugins: 5,
				loadedCount: 2,
				readyCount: 1,
				unloadedCount: 1,
				errorCount: 1,
				installedCount: 1,
				ejectedCount: 1,
			},
			data: { plugins, installed: [INSTALLED], ejected: [EJECTED] },
		});
		expect(replies).toEqual([text]);
	});

	it("returns the zero-count aggregate for an empty inventory", async () => {
		const { runtime } = createRuntime({});

		const result = await runPluginStatus({ runtime });

		expect(result.values).toEqual({
			mode: "status",
			totalPlugins: 0,
			loadedCount: 0,
			readyCount: 0,
			unloadedCount: 0,
			errorCount: 0,
			installedCount: 0,
			ejectedCount: 0,
		});
	});

	it("reports a missing named plugin without fabricating state", async () => {
		const { runtime } = createRuntime({});
		const { callback, replies } = createCallback();

		const result = await runPluginStatus({
			runtime,
			name: "missing",
			callback,
		});

		expect(result).toEqual({
			success: false,
			text: "No plugin state found for missing.",
			values: { mode: "status", name: "missing", found: false },
		});
		expect(replies).toEqual(["No plugin state found for missing."]);
	});

	it("normalizes names, keeps the first matching runtime entry, and summarizes lifecycle fields", async () => {
		const loadedAt = Date.parse("2026-08-20T10:00:00.000Z");
		const unloadedAt = Date.parse("2026-08-21T11:30:00.000Z");
		const first = pluginState("first", "plugin-alpha", PluginStatus.ERROR, {
			loadedAt,
			unloadedAt,
			error: "initialization failed",
		});
		const second = pluginState(
			"second",
			"@elizaos/plugin-alpha",
			PluginStatus.LOADED,
		);
		const { runtime } = createRuntime({
			plugins: [first, second],
			installed: [INSTALLED],
			ejected: [EJECTED],
		});

		const result = await runPluginStatus({
			runtime,
			name: " @ELIZAOS/plugin-alpha ",
		});

		const text = [
			"Plugin status for plugin-alpha:",
			"  runtime: plugin-alpha [error] loaded=2026-08-20T10:00:00.000Z unloaded=2026-08-21T11:30:00.000Z error=initialization failed",
			"  installed: yes (v2.3.4) at /plugins/alpha",
			"  ejected: yes (v2.3.3) at /ejected/alpha",
		].join("\n");
		expect(result).toMatchObject({
			success: true,
			text,
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			values: {
				mode: "status",
				name: " @ELIZAOS/plugin-alpha ",
				found: true,
				runtimeStatus: PluginStatus.ERROR,
				installed: true,
				ejected: true,
			},
		});
		expect(result.data).toEqual({
			state: first,
			installed: INSTALLED,
			ejected: EJECTED,
		});
	});

	it("matches an exact runtime id and renders absent managed records", async () => {
		const state = pluginState(
			"stable-plugin-id",
			"custom/plugin-beta",
			PluginStatus.READY,
		);
		const { runtime } = createRuntime({ plugins: [state] });

		const result = await runPluginStatus({
			runtime,
			name: "stable-plugin-id",
		});

		expect(result.text).toBe(
			[
				"Plugin status for custom/plugin-beta:",
				"  runtime: custom/plugin-beta [ready]",
				"  installed: no managed install found",
				"  ejected: no",
			].join("\n"),
		);
		expect(result.data).toEqual({
			state,
			installed: undefined,
			ejected: undefined,
		});
	});

	it("uses installed metadata when no runtime entry is registered", async () => {
		const { runtime } = createRuntime({ installed: [INSTALLED] });

		const result = await runPluginStatus({ runtime, name: "alpha" });

		expect(result.text).toBe(
			[
				"Plugin status for @elizaos/plugin-alpha:",
				"  runtime: not registered",
				"  installed: yes (v2.3.4) at /plugins/alpha",
				"  ejected: no",
			].join("\n"),
		);
		expect(result.values).toMatchObject({
			found: true,
			installed: true,
			ejected: false,
		});
	});
});

describe("runPluginDetails", () => {
	it("reports an unavailable service before validating the name", async () => {
		const { runtime } = createRuntime(null);
		const { callback, replies } = createCallback();

		const result = await runPluginDetails({ runtime, callback });

		expect(result).toEqual({
			success: false,
			text: "Plugin manager service not available",
		});
		expect(replies).toEqual(["Plugin manager service not available"]);
	});

	it("requires a plugin name without querying the registry", async () => {
		const { runtime, registryNames } = createRuntime({ registry: REGISTRY });
		const { callback, replies } = createCallback();

		const result = await runPluginDetails({ runtime, callback });

		expect(result).toEqual({
			success: false,
			text: "Specify a plugin name for details.",
		});
		expect(registryNames).toEqual([]);
		expect(replies).toEqual(["Specify a plugin name for details."]);
	});

	it("reports a plugin absent from both runtime state and registry", async () => {
		const { runtime, registryNames } = createRuntime({});

		const result = await runPluginDetails({ runtime, name: "missing" });

		expect(result).toEqual({
			success: false,
			text: 'Plugin "missing" not found in runtime state or registry.',
			values: { mode: "details", name: "missing" },
		});
		expect(registryNames).toEqual(["missing"]);
	});

	it("renders complete registry metadata before runtime state and caps displayed tags", async () => {
		const state = pluginState("alpha-id", "plugin-alpha", PluginStatus.LOADED);
		const { runtime } = createRuntime({ plugins: [state], registry: REGISTRY });
		const { callback, replies } = createCallback();

		const result = await runPluginDetails({
			runtime,
			name: "alpha",
			callback,
		});

		const text = [
			"@elizaos/plugin-alpha",
			"Description: Alpha integration",
			"Version: 2.3.4",
			"Repository: https://github.com/elizaos-plugins/plugin-alpha",
			"Tags: one, two, three, four, five, six, seven, eight",
			"",
			"Runtime: plugin-alpha [loaded]",
		].join("\n");
		expect(result).toEqual({
			success: true,
			text,
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			values: {
				mode: "details",
				name: "@elizaos/plugin-alpha",
				runtimeStatus: PluginStatus.LOADED,
				registryFound: true,
			},
			data: { state, registry: REGISTRY },
		});
		expect(replies).toEqual([text]);
	});

	it.each([
		[
			"v1",
			{ v2Version: null, v1Version: "1.8.0", v0Version: "0.9.0" },
			"1.8.0",
		],
		["v0", { v2Version: null, v1Version: null, v0Version: "0.9.0" }, "0.9.0"],
	])(
		"falls back to the %s registry version",
		async (_label, versions, expected) => {
			const registry: RegistryPlugin = {
				...REGISTRY,
				npm: { ...REGISTRY.npm, ...versions },
			};
			const { runtime } = createRuntime({ registry });

			const result = await runPluginDetails({ runtime, name: "alpha" });

			expect(result.text).toContain(`Version: ${expected}`);
		},
	);

	it("omits empty optional registry fields", async () => {
		const registry: RegistryPlugin = {
			...REGISTRY,
			description: "",
			gitRepo: "",
			topics: [],
			npm: {
				...REGISTRY.npm,
				v0Version: null,
				v1Version: null,
				v2Version: null,
			},
		};
		const { runtime } = createRuntime({ registry });

		const result = await runPluginDetails({ runtime, name: "alpha" });

		expect(result.text).toBe("@elizaos/plugin-alpha");
	});

	it("renders runtime-only details under the requested normalized name", async () => {
		const state = pluginState(
			"alpha-id",
			"@elizaos/plugin-alpha",
			PluginStatus.UNLOADED,
		);
		const { runtime } = createRuntime({ plugins: [state] });

		const result = await runPluginDetails({ runtime, name: "plugin-alpha" });

		expect(result.text).toBe("Runtime: @elizaos/plugin-alpha [unloaded]");
		expect(result.values).toEqual({
			mode: "details",
			name: "@elizaos/plugin-alpha",
			runtimeStatus: PluginStatus.UNLOADED,
			registryFound: false,
		});
	});
});

describe("runEnablePlugin and runDisablePlugin", () => {
	it.each([
		["enable", runEnablePlugin],
		["disable", runDisablePlugin],
	])("reports an unavailable service for %s", async (_label, handler) => {
		const { runtime } = createRuntime(null);

		const result = await handler({ runtime, name: "alpha" });

		expect(result).toEqual({
			success: false,
			text: "Plugin manager service not available",
		});
	});

	it.each([
		["enable", runEnablePlugin],
		["disable", runDisablePlugin],
	])("requires a name to %s a plugin", async (operation, handler) => {
		const { runtime } = createRuntime({});

		const result = await handler({ runtime });

		expect(result).toEqual({
			success: false,
			text: `Specify a plugin name to ${operation}.`,
		});
	});

	it.each([
		["enable", true, runEnablePlugin],
		["disable", false, runDisablePlugin],
	])(
		"rejects an unregistered plugin during %s",
		async (_label, enabled, handler) => {
			const { runtime } = createRuntime({});

			const result = await handler({ runtime, name: "missing" });

			expect(result).toEqual({
				success: false,
				text: 'Plugin "missing" is not registered in the current runtime.',
				values: { name: "missing", enabled },
			});
		},
	);

	it("enables by id and returns the service's updated plugin state", async () => {
		const initial = pluginState("alpha-id", "plugin-alpha", PluginStatus.READY);
		const updated = pluginState(
			"alpha-id",
			"plugin-alpha",
			PluginStatus.LOADED,
		);
		const { runtime, loadIds, unloadIds } = createRuntime({
			plugins: [initial],
			updated,
		});
		const { callback, replies } = createCallback();

		const result = await runEnablePlugin({
			runtime,
			name: "alpha",
			callback,
		});

		expect(loadIds).toEqual(["alpha-id"]);
		expect(unloadIds).toEqual([]);
		expect(result).toEqual({
			success: true,
			text: "Enabled the plugin-alpha plugin.",
			userFacingText: "Enabled the plugin-alpha plugin.",
			verifiedUserFacing: true,
			turnComplete: true,
			values: {
				mode: "enable",
				name: "plugin-alpha",
				status: PluginStatus.LOADED,
			},
			data: { plugin: updated },
		});
		expect(replies).toEqual(["Enabled the plugin-alpha plugin."]);
	});

	it("disables by id and falls back to the original state when no update is returned", async () => {
		const initial = pluginState(
			"alpha-id",
			"plugin-alpha",
			PluginStatus.LOADED,
		);
		const { runtime, loadIds, unloadIds } = createRuntime({
			plugins: [initial],
		});

		const result = await runDisablePlugin({ runtime, name: "alpha" });

		expect(loadIds).toEqual([]);
		expect(unloadIds).toEqual(["alpha-id"]);
		expect(result.values).toEqual({
			mode: "disable",
			name: "plugin-alpha",
			status: PluginStatus.LOADED,
		});
		expect(result.data).toEqual({ plugin: initial });
	});

	it("returns the raw Error message while sending a humanized enable failure", async () => {
		const state = pluginState("alpha-id", "plugin-alpha", PluginStatus.READY);
		const { runtime } = createRuntime({
			plugins: [state],
			loadError: new Error("dependency unavailable"),
		});
		const { callback, replies } = createCallback();

		const result = await runEnablePlugin({
			runtime,
			name: "alpha",
			callback,
		});

		expect(result).toEqual({
			success: false,
			text: "Failed to enable plugin-alpha: dependency unavailable",
			error: "dependency unavailable",
			values: { name: "plugin-alpha", enabled: true },
		});
		expect(replies).toEqual([
			"I couldn't enable the plugin-alpha plugin — something went wrong on my end.",
		]);
	});

	it("stringifies non-Error disable failures", async () => {
		const state = pluginState("alpha-id", "plugin-alpha", PluginStatus.LOADED);
		const { runtime } = createRuntime({
			plugins: [state],
			unloadError: "protected plugin",
		});

		const result = await runDisablePlugin({ runtime, name: "alpha" });

		expect(result).toEqual({
			success: false,
			text: "Failed to disable plugin-alpha: protected plugin",
			error: "protected plugin",
			values: { name: "plugin-alpha", enabled: false },
		});
	});
});
