/**
 * Deterministic unit coverage for the plugin-configuration status provider.
 * The suite drives the real provider and configuration service with in-memory
 * plugin state, covering relevance, aggregation, rendering, and failures.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Memory } from "../../../types/memory.ts";
import type { Plugin } from "../../../types/plugin.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import type { State } from "../../../types/state.ts";
import { PluginConfigurationService } from "../services/pluginConfigurationService.ts";
import type { PluginManagerService } from "../services/pluginManagerService.ts";
import {
	PluginManagerServiceType,
	type PluginState,
	PluginStatus,
} from "../types.ts";
import { pluginConfigurationStatusProvider } from "./pluginConfigurationStatus.ts";

const MISSING_KEY = "ELIZA_TEST_PLUGIN_CONFIGURATION_STATUS_MISSING";

function makeMessage(text: string): Memory {
	return { content: { text } } as Memory;
}

function makePlugin(
	name: string,
	config?: Record<string, string | null>,
): Plugin {
	return {
		name,
		description: `${name} test plugin`,
		...(config ? { config } : {}),
	} as Plugin;
}

function makePluginState(
	name: string,
	status: PluginStatus,
	plugin?: Plugin,
): PluginState {
	return {
		id: `${name}-id`,
		name,
		status,
		plugin,
		createdAt: 1,
	};
}

function makeRuntime(pluginStates: PluginState[]) {
	const reportedErrors: Array<{ scope: string; error: unknown }> = [];
	const pluginManager = {
		getAllPlugins: () => pluginStates,
	} as unknown as PluginManagerService;
	let configurationService: PluginConfigurationService;
	const runtime = {
		getService: (serviceType: string) => {
			if (serviceType === PluginManagerServiceType.PLUGIN_MANAGER) {
				return pluginManager;
			}
			if (serviceType === PluginManagerServiceType.PLUGIN_CONFIGURATION) {
				return configurationService;
			}
			return null;
		},
		reportError: (scope: string, error: unknown) => {
			reportedErrors.push({ scope, error });
		},
	} as unknown as IAgentRuntime;
	configurationService = new PluginConfigurationService(runtime);

	return { runtime, reportedErrors };
}

afterEach(() => {
	delete process.env[MISSING_KEY];
});

describe("pluginConfigurationStatusProvider", () => {
	it("exposes its scheduling, context, and owner authorization contract", () => {
		expect(pluginConfigurationStatusProvider).toMatchObject({
			name: "pluginConfigurationStatus",
			dynamic: true,
			contexts: ["connectors", "settings"],
			contextGate: { anyOf: ["connectors", "settings"] },
			cacheStable: false,
			cacheScope: "turn",
			roleGate: { minRole: "OWNER" },
		});
		expect(pluginConfigurationStatusProvider.relevanceKeywords).toContain(
			"missing env",
		);
	});

	it("stays silent for an unrelated message", async () => {
		const { runtime } = makeRuntime([]);

		await expect(
			pluginConfigurationStatusProvider.get(
				runtime,
				makeMessage("What is the weather today?"),
				{} as State,
			),
		).resolves.toEqual({ text: "" });
	});

	it("uses registered plugin names as dynamic relevance keywords", async () => {
		const plugin = makePlugin("@acme/plugin-nebula");
		const { runtime } = makeRuntime([
			makePluginState(plugin.name, PluginStatus.LOADED, plugin),
		]);

		const result = await pluginConfigurationStatusProvider.get(
			runtime,
			makeMessage("How is nebula doing?"),
			{} as State,
		);

		expect(result.values).toMatchObject({
			totalPlugins: 1,
			configuredPlugins: 1,
			needsConfiguration: 0,
		});
		expect(result.text).toContain("Total: 1, Configured: 1, Needs config: 0");
	});

	it.each(["plugin manager", "configuration"] as const)(
		"returns an explicit unavailable result when the %s service is missing",
		async (missingService) => {
			const { runtime: completeRuntime } = makeRuntime([]);
			const runtime = {
				getService: (serviceType: string) => {
					if (
						missingService === "plugin manager" &&
						serviceType === PluginManagerServiceType.PLUGIN_MANAGER
					) {
						return null;
					}
					if (
						missingService === "configuration" &&
						serviceType === PluginManagerServiceType.PLUGIN_CONFIGURATION
					) {
						return null;
					}
					return completeRuntime.getService(serviceType);
				},
				reportError: completeRuntime.reportError.bind(completeRuntime),
			} as unknown as IAgentRuntime;

			await expect(
				pluginConfigurationStatusProvider.get(
					runtime,
					makeMessage("Show plugin configuration status"),
					{} as State,
				),
			).resolves.toEqual({
				text: "Configuration or plugin manager service not available",
				data: { available: false },
				values: { configurationServicesAvailable: false },
			});
		},
	);

	it("reports an empty registry without fabricating plugin records", async () => {
		const { runtime } = makeRuntime([]);

		await expect(
			pluginConfigurationStatusProvider.get(
				runtime,
				makeMessage("Show plugin configuration status"),
				{} as State,
			),
		).resolves.toEqual({
			text: "No plugins registered.",
			data: { plugins: [], truncated: false },
			values: {
				configurationServicesAvailable: true,
				totalPlugins: 0,
				configuredPlugins: 0,
				needsConfiguration: 0,
				hasUnconfiguredPlugins: false,
			},
		});
	});

	it("preserves registry order and aggregates configured, missing, and metadata-only plugins", async () => {
		delete process.env[MISSING_KEY];
		const configured = makePlugin("configured-plugin", {
			CONFIGURED_WITH_DEFAULT: "default-value",
		});
		const missing = makePlugin("missing-plugin", { [MISSING_KEY]: "" });
		const pluginStates = [
			makePluginState("metadata-only", PluginStatus.ERROR),
			makePluginState(configured.name, PluginStatus.LOADED, configured),
			makePluginState(missing.name, PluginStatus.READY, missing),
		];
		const { runtime } = makeRuntime(pluginStates);

		const result = await pluginConfigurationStatusProvider.get(
			runtime,
			makeMessage("Which plugins have missing environment variables?"),
			{} as State,
		);

		expect(result.data).toEqual({
			plugins: [
				{
					name: "metadata-only",
					status: PluginStatus.ERROR,
					configured: true,
					missingKeys: [],
					totalKeys: 0,
				},
				{
					name: "configured-plugin",
					status: PluginStatus.LOADED,
					configured: true,
					missingKeys: [],
					totalKeys: 1,
				},
				{
					name: "missing-plugin",
					status: PluginStatus.READY,
					configured: false,
					missingKeys: [MISSING_KEY],
					totalKeys: 1,
				},
			],
			truncated: false,
		});
		expect(result.values).toEqual({
			configurationServicesAvailable: true,
			totalPlugins: 3,
			configuredPlugins: 2,
			needsConfiguration: 1,
			hasUnconfiguredPlugins: true,
		});
		expect(result.text).toBe(
			"Plugin Configuration Status:\n" +
				"Total: 3, Configured: 2, Needs config: 1\n" +
				"\nPlugins needing configuration:\n" +
				`- missing-plugin: missing ${MISSING_KEY}\n`,
		);
	});

	it.each([
		[new Error("registry unavailable"), "registry unavailable"],
		["non-error failure", "non-error failure"],
	] as const)(
		"reports provider failures and serializes %s",
		async (failure, expectedMessage) => {
			const reportedErrors: Array<{ scope: string; error: unknown }> = [];
			const runtime = {
				getService: () => ({
					getAllPlugins: () => {
						throw failure;
					},
				}),
				reportError: (scope: string, error: unknown) => {
					reportedErrors.push({ scope, error });
				},
			} as unknown as IAgentRuntime;

			await expect(
				pluginConfigurationStatusProvider.get(
					runtime,
					makeMessage("Show plugin configuration status"),
					{} as State,
				),
			).resolves.toEqual({
				text: "Plugin configuration status unavailable",
				data: { available: false, error: expectedMessage },
				values: { configurationServicesAvailable: false },
			});
			expect(reportedErrors).toEqual([
				{
					scope: "PluginConfigurationStatusProvider.get",
					error: failure,
				},
			]);
		},
	);
});
