/**
 * Proves the issue #13422 P4 core read-migrations resolve a branded (non-ELIZA)
 * env prefix through the boot-config alias table WITHOUT the syncBrandEnvToEliza
 * mirror: resolveTrajectoryDir (ELIZA_STATE_DIR) and isElizaSettingsDebugEnabled
 * (ELIZA_SETTINGS_DEBUG / VITE_ELIZA_SETTINGS_DEBUG) now read via
 * resolveAliasedEnvValue. Deterministic; installs and restores the shared
 * boot-config global slot and process.env around each case. No mocks — the real
 * migrated functions run against the real alias resolver.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTrajectoryDir } from "./runtime/trajectory-recorder";
import { isElizaSettingsDebugEnabled } from "./settings-debug";

const STORE_KEY = Symbol.for("elizaos.app.boot-config");
const WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";
type Slot = Record<PropertyKey, unknown>;

// The real MILADY-branded pairs for the keys under test. A NON-ELIZA prefix is
// the security-relevant fixture; an ELIZA->ELIZA self-mirror proves nothing.
const MILADY_ALIASES = [
	["MILADY_STATE_DIR", "ELIZA_STATE_DIR"],
	["MILADY_SETTINGS_DEBUG", "ELIZA_SETTINGS_DEBUG"],
	["VITE_MILADY_SETTINGS_DEBUG", "VITE_ELIZA_SETTINGS_DEBUG"],
] as const;

describe("issue #13422 core read-migrations resolve a branded prefix without the mirror", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const tracked = [
		"ELIZA_TRAJECTORY_DIR",
		"MILADY_STATE_DIR",
		"ELIZA_STATE_DIR",
		"MILADY_SETTINGS_DEBUG",
		"ELIZA_SETTINGS_DEBUG",
		"VITE_MILADY_SETTINGS_DEBUG",
		"VITE_ELIZA_SETTINGS_DEBUG",
	];
	let savedStore: unknown;
	let savedWindow: unknown;

	beforeEach(() => {
		const slot = globalThis as Slot;
		savedStore = slot[STORE_KEY];
		savedWindow = slot[WINDOW_KEY];
		for (const key of tracked) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		// Install the alias table on the shared boot-config store exactly as the app
		// boot path does; this is what makes resolveAliasedEnvValue's default alias
		// source resolve branded keys inside the migrated functions.
		slot[STORE_KEY] = { current: { envAliases: MILADY_ALIASES } };
	});

	afterEach(() => {
		const slot = globalThis as Slot;
		if (savedStore === undefined) delete slot[STORE_KEY];
		else slot[STORE_KEY] = savedStore;
		if (savedWindow === undefined) delete slot[WINDOW_KEY];
		else slot[WINDOW_KEY] = savedWindow;
		for (const key of tracked) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	it("resolveTrajectoryDir derives from a branded MILADY_STATE_DIR with zero mirror writes", () => {
		process.env.MILADY_STATE_DIR = "/var/milady/state";
		const before = { ...process.env };

		expect(resolveTrajectoryDir()).toBe(
			path.join("/var/milady/state", "trajectories"),
		);

		// The migrated read must not materialize the ELIZA_ target.
		expect(process.env.ELIZA_STATE_DIR).toBeUndefined();
		expect(process.env).toEqual(before);
	});

	it("resolveTrajectoryDir prefers a canonical ELIZA_STATE_DIR over the branded alias", () => {
		process.env.ELIZA_STATE_DIR = "/var/eliza/state";
		process.env.MILADY_STATE_DIR = "/var/milady/state";
		expect(resolveTrajectoryDir()).toBe(
			path.join("/var/eliza/state", "trajectories"),
		);
	});

	it("isElizaSettingsDebugEnabled honors a branded MILADY_SETTINGS_DEBUG with zero mirror writes", () => {
		process.env.MILADY_SETTINGS_DEBUG = "1";
		const before = { ...process.env };

		expect(isElizaSettingsDebugEnabled()).toBe(true);

		expect(process.env.ELIZA_SETTINGS_DEBUG).toBeUndefined();
		expect(process.env).toEqual(before);
	});

	it("isElizaSettingsDebugEnabled honors a branded VITE_MILADY_SETTINGS_DEBUG", () => {
		process.env.VITE_MILADY_SETTINGS_DEBUG = "true";
		expect(isElizaSettingsDebugEnabled()).toBe(true);
		expect(process.env.VITE_ELIZA_SETTINGS_DEBUG).toBeUndefined();
	});

	it("stays false when neither the branded nor canonical flag is set", () => {
		expect(isElizaSettingsDebugEnabled()).toBe(false);
	});

	it("a canonical ELIZA_SETTINGS_DEBUG=0 wins over a branded truthy alias", () => {
		// Canonical precedence: an explicit ELIZA_ '0' is the resolved value, so the
		// branded '1' never surfaces — debug stays off.
		process.env.ELIZA_SETTINGS_DEBUG = "0";
		process.env.MILADY_SETTINGS_DEBUG = "1";
		expect(isElizaSettingsDebugEnabled()).toBe(false);
	});
});
