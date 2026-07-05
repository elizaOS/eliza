/**
 * Proves the #13422 alias-reader migration for the boot-critical env keys in the
 * P6 partition: a non-ELIZA brand prefix (MILADY_<KEY>) resolves through the
 * alias-aware readers, the canonical ELIZA_<KEY> wins when both are present, a
 * blank ELIZA_<KEY> never shadows a real branded alias, and — the
 * security-critical invariant — resolving a branded-only key NEVER writes the
 * mirrored ELIZA_<KEY> back onto `process.env`. Drives the real migrated code
 * path (`isRestrictedPlatform` reads `resolvePlatform`) plus the readers every
 * other migrated site in this partition now calls.
 */

import {
	buildBrandEnvAliases,
	getBootConfig,
	readAliasedEnv,
	resolveApiToken,
	resolveDesktopApiPort,
	resolvePlatform,
	setBootConfig,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRestrictedPlatform } from "./views-platform.js";

// Every ELIZA_* key this partition migrated, plus its MILADY_ alias partner.
const MIGRATED_KEYS = [
	"ELIZA_PLATFORM",
	"ELIZA_STATE_DIR",
	"ELIZA_CONFIG_PATH",
	"ELIZA_CLOUD_PROVISIONED",
	"ELIZA_SKIP_LOCAL_PLUGIN_ROLES",
	"ELIZA_WALLET_EXPORT_TOKEN",
	"ELIZA_API_TOKEN",
	"ELIZA_API_PORT",
	"ELIZA_PORT",
	"ELIZA_BUILD_VARIANT",
] as const;
const BRAND_KEYS = MIGRATED_KEYS.map((k) => k.replace(/^ELIZA_/, "MILADY_"));

let savedEnv: Record<string, string | undefined>;
let savedBootConfig: ReturnType<typeof getBootConfig>;

beforeEach(() => {
	savedEnv = {};
	for (const key of [...MIGRATED_KEYS, ...BRAND_KEYS]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	savedBootConfig = getBootConfig();
	// Install a genuine non-ELIZA brand alias table (MILADY) so the readers must
	// consult it — exactly what a rebranded distribution ships.
	setBootConfig({ branding: {}, envAliases: buildBrandEnvAliases("MILADY") });
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	setBootConfig(savedBootConfig);
});

describe("#13422 P6 alias-reader migration", () => {
	it("resolves a branded MILADY_PLATFORM through the migrated isRestrictedPlatform path", () => {
		process.env.MILADY_PLATFORM = "android";
		expect(resolvePlatform()).toBe("android");
		expect(isRestrictedPlatform()).toBe(true);
		// The security-critical invariant: reading the alias must NOT mirror the
		// value back onto the canonical ELIZA_ key.
		expect(process.env.ELIZA_PLATFORM).toBeUndefined();
	});

	it("lets the canonical ELIZA_PLATFORM win over the branded alias", () => {
		process.env.ELIZA_PLATFORM = "linux";
		process.env.MILADY_PLATFORM = "android";
		expect(resolvePlatform()).toBe("linux");
		// linux is not a restricted mobile platform, so the canonical value drives
		// the migrated decision even though the branded alias says android.
		expect(isRestrictedPlatform()).toBe(false);
	});

	it("treats a blank canonical ELIZA_PLATFORM as unset (does not shadow the alias)", () => {
		process.env.ELIZA_PLATFORM = "   ";
		process.env.MILADY_PLATFORM = "android";
		expect(resolvePlatform()).toBe("android");
		expect(isRestrictedPlatform()).toBe(true);
	});

	it("readAliasedEnv resolves branded aliases, honours ELIZA precedence, and never mirrors", () => {
		const cases: Array<[eliza: string, brand: string]> = [
			["ELIZA_STATE_DIR", "MILADY_STATE_DIR"],
			["ELIZA_CONFIG_PATH", "MILADY_CONFIG_PATH"],
			["ELIZA_CLOUD_PROVISIONED", "MILADY_CLOUD_PROVISIONED"],
			["ELIZA_SKIP_LOCAL_PLUGIN_ROLES", "MILADY_SKIP_LOCAL_PLUGIN_ROLES"],
			["ELIZA_WALLET_EXPORT_TOKEN", "MILADY_WALLET_EXPORT_TOKEN"],
		];
		for (const [elizaKey, brandKey] of cases) {
			// Branded alias only → resolves, canonical stays unwritten.
			process.env[brandKey] = "brand-value";
			expect(readAliasedEnv(elizaKey)).toBe("brand-value");
			expect(process.env[elizaKey]).toBeUndefined();

			// Both present → canonical ELIZA_ wins.
			process.env[elizaKey] = "canonical-value";
			expect(readAliasedEnv(elizaKey)).toBe("canonical-value");

			// Blank canonical → branded alias resurfaces (empty-is-unset).
			process.env[elizaKey] = "   ";
			expect(readAliasedEnv(elizaKey)).toBe("brand-value");

			delete process.env[elizaKey];
			delete process.env[brandKey];
		}
	});

	it("resolveApiToken resolves MILADY_API_TOKEN and prefers the canonical token", () => {
		process.env.MILADY_API_TOKEN = "brand-token";
		expect(resolveApiToken()).toBe("brand-token");
		expect(process.env.ELIZA_API_TOKEN).toBeUndefined();

		process.env.ELIZA_API_TOKEN = "canonical-token";
		expect(resolveApiToken()).toBe("canonical-token");
	});

	it("resolveDesktopApiPort resolves MILADY_API_PORT and prefers the canonical port", () => {
		process.env.MILADY_API_PORT = "41337";
		expect(resolveDesktopApiPort()).toBe(41337);
		expect(process.env.ELIZA_API_PORT).toBeUndefined();

		process.env.ELIZA_API_PORT = "42000";
		expect(resolveDesktopApiPort()).toBe(42000);
	});
});
