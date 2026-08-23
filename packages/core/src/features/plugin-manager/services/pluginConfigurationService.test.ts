/**
 * Exercises plugin configuration readiness through the real service methods,
 * with process environment changes isolated to test-only key names.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { Plugin } from "../../../types/plugin.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import { PluginManagerServiceType } from "../types.ts";
import { PluginConfigurationService } from "./pluginConfigurationService.ts";

const configuredKey = "ELIZA_TEST_PLUGIN_CONFIGURATION_CONFIGURED";
const emptyKey = "ELIZA_TEST_PLUGIN_CONFIGURATION_EMPTY";

function createPlugin(config?: Plugin["config"]): Plugin {
	return {
		name: "test-plugin",
		description: "Plugin configuration service test fixture",
		...(config === undefined ? {} : { config }),
	};
}

function createService(): PluginConfigurationService {
	return new PluginConfigurationService({} as IAgentRuntime);
}

afterEach(() => {
	delete process.env[configuredKey];
	delete process.env[emptyKey];
});

describe("PluginConfigurationService", () => {
	it("starts and stops with the plugin configuration service contract", async () => {
		const service = await PluginConfigurationService.start({} as IAgentRuntime);

		expect(service).toBeInstanceOf(PluginConfigurationService);
		expect(PluginConfigurationService.serviceType).toBe(
			PluginManagerServiceType.PLUGIN_CONFIGURATION,
		);
		expect(service.capabilityDescription).toBe(
			"Checks plugin configuration status against runtime settings",
		);
		await expect(service.stop()).resolves.toBeUndefined();
	});

	it("reports a plugin without a config schema as configured", () => {
		const service = createService();
		const plugin = createPlugin();

		expect(service.getMissingConfigKeys(plugin)).toEqual([]);
		expect(service.getPluginConfigStatus(plugin)).toEqual({
			configured: true,
			missingKeys: [],
			totalKeys: 0,
		});
	});

	it("reports an empty config schema as configured", () => {
		const service = createService();
		const plugin = createPlugin({});

		expect(service.getPluginConfigStatus(plugin)).toEqual({
			configured: true,
			missingKeys: [],
			totalKeys: 0,
		});
	});

	it("preserves declaration order for missing null and empty-string defaults", () => {
		const service = createService();
		const plugin = createPlugin({
			FIRST_REQUIRED: null,
			OPTIONAL_STRING: "fallback",
			SECOND_REQUIRED: "",
			OPTIONAL_NUMBER: 0,
			OPTIONAL_BOOLEAN: false,
		});

		expect(service.getMissingConfigKeys(plugin)).toEqual([
			"FIRST_REQUIRED",
			"SECOND_REQUIRED",
		]);
		expect(service.getPluginConfigStatus(plugin)).toEqual({
			configured: false,
			missingKeys: ["FIRST_REQUIRED", "SECOND_REQUIRED"],
			totalKeys: 5,
		});
	});

	it("accepts a non-empty environment value but rejects an empty one", () => {
		process.env[configuredKey] = "available";
		process.env[emptyKey] = "";
		const service = createService();
		const plugin = createPlugin({
			[configuredKey]: null,
			[emptyKey]: null,
		});

		expect(service.getPluginConfigStatus(plugin)).toEqual({
			configured: false,
			missingKeys: [emptyKey],
			totalKeys: 2,
		});
	});
});
