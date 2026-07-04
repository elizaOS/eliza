/**
 * Regression coverage for capability configuration living in the declaring
 * plugin instead of a central name-keyed branch in `registerPlugin` (#12657).
 *
 * Boots real AgentRuntimes (no DB, migrations skipped) and asserts that the
 * capability config the runtime resolves — from explicit constructor options
 * AND from the character-settings fallback that used to live only inside the
 * deleted `plugin.name === "basic-capabilities"` branch — is reflected in the
 * actions the runtime actually registers. A source guard proves the name-keyed
 * special case is gone from the executable registration path.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../runtime.ts";
import type { Character } from "../../types/agent.ts";
import {
	type CapabilitySettingFlags,
	type ExplicitCapabilityOptions,
	resolveCapabilityConfig,
} from "./index.ts";

const ADVANCED_ACTION = "ROLE";
const BASIC_ACTION = "REPLY";

function actionNames(runtime: AgentRuntime): Set<string> {
	return new Set(runtime.actions.map((action) => action.name));
}

async function bootRuntime(
	opts: ConstructorParameters<typeof AgentRuntime>[0],
): Promise<AgentRuntime> {
	const runtime = new AgentRuntime({ logLevel: "fatal", ...opts });
	await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
	return runtime;
}

describe("resolveCapabilityConfig", () => {
	it("prefers explicit options over character settings", () => {
		const options: ExplicitCapabilityOptions = {
			disableBasic: false,
			enableExtended: false,
		};
		const settings: CapabilitySettingFlags = {
			DISABLE_BASIC_CAPABILITIES: "true",
			ENABLE_EXTENDED_CAPABILITIES: "true",
		};

		const config = resolveCapabilityConfig(options, settings);

		expect(config.disableBasic).toBe(false);
		expect(config.enableExtended).toBe(false);
	});

	it("falls back to character settings when an option is unspecified", () => {
		const config = resolveCapabilityConfig(
			{},
			{
				ENABLE_EXTENDED_CAPABILITIES: "true",
				ENABLE_AUTONOMY: true,
			},
		);

		expect(config.enableExtended).toBe(true);
		expect(config.enableAutonomy).toBe(true);
		// Unspecified everywhere resolves to a concrete false, never undefined,
		// so the plugin factory receives a fully-resolved config.
		expect(config.disableBasic).toBe(false);
		expect(config.enableTrust).toBe(false);
	});

	it("treats ADVANCED_CAPABILITIES as an alias for ENABLE_EXTENDED_CAPABILITIES", () => {
		expect(
			resolveCapabilityConfig({}, { ADVANCED_CAPABILITIES: "true" })
				.enableExtended,
		).toBe(true);
	});

	it("resolves an empty config to all-off (except forced flags left to caller)", () => {
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
});

describe("basic-capabilities registration through the declaring plugin", () => {
	it("registers only basic actions with the default config", async () => {
		const runtime = await bootRuntime({
			character: { name: "cap-default" } as Character,
		});
		const names = actionNames(runtime);
		expect(names.has(BASIC_ACTION)).toBe(true);
		expect(names.has(ADVANCED_ACTION)).toBe(false);
	});

	// The drift/fallback mode that made the central coupling unsafe: extended
	// capabilities requested ONLY through character settings (not a constructor
	// option). This path used to be re-derived inside the name-keyed branch;
	// it now flows through resolveCapabilityConfig in the constructor.
	it("enables advanced actions from ENABLE_EXTENDED_CAPABILITIES character settings", async () => {
		const runtime = await bootRuntime({
			character: {
				name: "cap-extended-via-settings",
				settings: { ENABLE_EXTENDED_CAPABILITIES: "true" },
			} as Character,
		});
		const names = actionNames(runtime);
		expect(names.has(ADVANCED_ACTION)).toBe(true);
		expect(names.has(BASIC_ACTION)).toBe(true);
	});

	it("enables advanced actions from the ADVANCED_CAPABILITIES alias setting", async () => {
		const runtime = await bootRuntime({
			character: {
				name: "cap-extended-via-alias",
				settings: { ADVANCED_CAPABILITIES: true },
			} as Character,
		});
		expect(actionNames(runtime).has(ADVANCED_ACTION)).toBe(true);
	});

	it("lets an explicit constructor option enable advanced actions", async () => {
		const runtime = await bootRuntime({
			character: { name: "cap-extended-via-opt" } as Character,
			enableExtendedCapabilities: true,
		});
		expect(actionNames(runtime).has(ADVANCED_ACTION)).toBe(true);
	});

	it("lets a constructor option override an on character setting (explicit wins)", async () => {
		const runtime = await bootRuntime({
			character: {
				name: "cap-opt-overrides-setting",
				settings: { ENABLE_EXTENDED_CAPABILITIES: "true" },
			} as Character,
			enableExtendedCapabilities: false,
		});
		expect(actionNames(runtime).has(ADVANCED_ACTION)).toBe(false);
	});

	it("drops basic actions when disableBasic is requested via character settings", async () => {
		const runtime = await bootRuntime({
			character: {
				name: "cap-disable-basic",
				settings: { DISABLE_BASIC_CAPABILITIES: "true" },
			} as Character,
		});
		expect(actionNames(runtime).has(BASIC_ACTION)).toBe(false);
	});
});

describe("name-keyed special case is gone from the registration path", () => {
	it("does not branch on plugin.name === 'basic-capabilities' in runtime.ts", () => {
		const runtimeSource = readFileSync(
			fileURLToPath(new URL("../../runtime.ts", import.meta.url)),
			"utf8",
		);
		expect(runtimeSource).not.toMatch(
			/plugin\.name\s*===\s*["']basic-capabilities["']/,
		);
		expect(runtimeSource).not.toMatch(
			/name\s*===\s*["']basic-capabilities["']/,
		);
	});
});
