/**
 * Unit coverage for basic-capabilities capability config resolution in config.ts.
 *
 * Tests resolveCapabilityConfig precedence (explicit options over character settings flags),
 * boolean and string flag coercion, and default false assignments.
 */

import { describe, expect, it } from "vitest";
import { resolveCapabilityConfig } from "./config.js";

describe("basic-capabilities config", () => {
	it("resolves defaults when both options and settings are empty", () => {
		const config = resolveCapabilityConfig({}, undefined);

		expect(config).toEqual({
			disableBasic: false,
			enableExtended: false,
			skipCharacterProvider: false,
			enableAutonomy: false,
			enableTrust: false,
			enableSecretsManager: false,
			enablePluginManager: false,
		});
	});

	it("prioritizes explicit options over character settings flags", () => {
		const config = resolveCapabilityConfig(
			{
				disableBasic: true,
				enableAutonomy: false,
				enableTrust: true,
				enableSecretsManager: false,
				skipCharacterProvider: true,
			},
			{
				DISABLE_BASIC_CAPABILITIES: false,
				ENABLE_AUTONOMY: true,
				ENABLE_TRUST: false,
				ENABLE_SECRETS_MANAGER: "true",
			},
		);

		expect(config.disableBasic).toBe(true);
		expect(config.enableAutonomy).toBe(false);
		expect(config.enableTrust).toBe(true);
		expect(config.enableSecretsManager).toBe(false);
		expect(config.skipCharacterProvider).toBe(true);
	});

	it("parses boolean and string character settings flags", () => {
		const config = resolveCapabilityConfig(
			{},
			{
				DISABLE_BASIC_CAPABILITIES: "true",
				ENABLE_EXTENDED_CAPABILITIES: true,
				ENABLE_AUTONOMY: "true",
				ENABLE_TRUST: true,
				ENABLE_SECRETS_MANAGER: "true",
				ENABLE_PLUGIN_MANAGER: true,
			},
		);

		expect(config.disableBasic).toBe(true);
		expect(config.enableExtended).toBe(true);
		expect(config.enableAutonomy).toBe(true);
		expect(config.enableTrust).toBe(true);
		expect(config.enableSecretsManager).toBe(true);
		expect(config.enablePluginManager).toBe(true);
	});

	it("supports advancedCapabilities option as alias for enableExtended", () => {
		const config1 = resolveCapabilityConfig({ advancedCapabilities: true }, {});
		expect(config1.enableExtended).toBe(true);

		const config2 = resolveCapabilityConfig(
			{},
			{ ADVANCED_CAPABILITIES: "true" },
		);
		expect(config2.enableExtended).toBe(true);
	});
});
