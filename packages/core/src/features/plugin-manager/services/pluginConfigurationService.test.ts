/**
 * Unit tests for PluginConfigurationService: verifies missing config key
 * resolution from real plugin declared schemas and environment variables.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plugin } from "../../../types/plugin.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import { PluginConfigurationService } from "./pluginConfigurationService.ts";

describe("PluginConfigurationService", () => {
	let service: PluginConfigurationService;
	const originalEnv = { ...process.env };

	beforeEach(() => {
		const runtime = {} as IAgentRuntime;
		service = new PluginConfigurationService(runtime);
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("returns empty missing keys when plugin has no config schema", () => {
		const plugin: Plugin = {
			name: "test-plugin",
			description: "test description",
		};
		expect(service.getMissingConfigKeys(plugin)).toEqual([]);
		expect(service.getPluginConfigStatus(plugin)).toEqual({
			configured: true,
			missingKeys: [],
			totalKeys: 0,
		});
	});

	it("identifies missing required config keys when environment variables are unset", () => {
		delete process.env.TEST_API_KEY;
		const plugin: Plugin = {
			name: "test-plugin",
			description: "test description",
			config: {
				TEST_API_KEY: null,
				OPTIONAL_SETTING: "default_value",
			},
		};

		const missing = service.getMissingConfigKeys(plugin);
		expect(missing).toEqual(["TEST_API_KEY"]);

		const status = service.getPluginConfigStatus(plugin);
		expect(status.configured).toBe(false);
		expect(status.missingKeys).toEqual(["TEST_API_KEY"]);
		expect(status.totalKeys).toBe(2);
	});

	it("considers plugin configured when all required keys are in process.env", () => {
		process.env.TEST_API_KEY = "secret_key_123";
		const plugin: Plugin = {
			name: "test-plugin",
			description: "test description",
			config: {
				TEST_API_KEY: null,
			},
		};

		const status = service.getPluginConfigStatus(plugin);
		expect(status.configured).toBe(true);
		expect(status.missingKeys).toEqual([]);
	});
});
