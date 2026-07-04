/**
 * Covers boot-env's env-alias mirroring (branded ↔ ELIZA_ keys with stale-target
 * clearing) and the write-once boot-config store: a late window mirror cannot
 * replace an established store, and the singleton is held through the
 * ambient-context accessor. Deterministic; mutates and restores process.env and
 * globalThis around each case.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { peekAmbientSingleton } from "./ambient-context";
import {
	resolveAliasedEnvValue,
	syncAppEnvToEliza,
	syncBrandEnvToEliza,
	syncElizaEnvToBrand,
} from "./boot-env";

function withCleanEnv(keys: string[], run: () => void): void {
	const previous = new Map(keys.map((key) => [key, process.env[key]] as const));
	try {
		for (const key of keys) {
			delete process.env[key];
		}
		run();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

describe("boot env alias syncing", () => {
	it("mirrors branded env to Eliza env and clears stale mirrored targets", () => {
		const keys = [
			"ELIZA_BOOT_ENV_TEST_SOURCE",
			"ELIZA_BOOT_ENV_TEST_MISSING",
			"ELIZA_BOOT_ENV_TEST_TARGET",
			"ELIZA_BOOT_ENV_TEST_MANUAL",
		];
		withCleanEnv(keys, () => {
			process.env.ELIZA_BOOT_ENV_TEST_SOURCE = "brand-value";
			process.env.ELIZA_BOOT_ENV_TEST_MANUAL = "manual-value";

			syncBrandEnvToEliza([
				["ELIZA_BOOT_ENV_TEST_SOURCE", "ELIZA_BOOT_ENV_TEST_TARGET"],
				["ELIZA_BOOT_ENV_TEST_MISSING", "ELIZA_BOOT_ENV_TEST_MANUAL"],
			]);

			expect(process.env.ELIZA_BOOT_ENV_TEST_TARGET).toBe("brand-value");
			expect(process.env.ELIZA_BOOT_ENV_TEST_MANUAL).toBe("manual-value");

			delete process.env.ELIZA_BOOT_ENV_TEST_SOURCE;
			syncBrandEnvToEliza([
				["ELIZA_BOOT_ENV_TEST_SOURCE", "ELIZA_BOOT_ENV_TEST_TARGET"],
			]);

			expect(process.env.ELIZA_BOOT_ENV_TEST_TARGET).toBeUndefined();
		});
	});

	it("mirrors Eliza env to branded env and clears stale mirrored targets", () => {
		const keys = [
			"ELIZA_BOOT_ENV_TEST_TARGET",
			"ELIZA_BOOT_ENV_TEST_MANUAL",
			"ELIZA_BOOT_ENV_TEST_SOURCE",
			"ELIZA_BOOT_ENV_TEST_MISSING",
		];
		withCleanEnv(keys, () => {
			process.env.ELIZA_BOOT_ENV_TEST_SOURCE = "eliza-value";
			process.env.ELIZA_BOOT_ENV_TEST_MANUAL = "manual-value";

			syncElizaEnvToBrand([
				["ELIZA_BOOT_ENV_TEST_TARGET", "ELIZA_BOOT_ENV_TEST_SOURCE"],
				["ELIZA_BOOT_ENV_TEST_MANUAL", "ELIZA_BOOT_ENV_TEST_MISSING"],
			]);

			expect(process.env.ELIZA_BOOT_ENV_TEST_TARGET).toBe("eliza-value");
			expect(process.env.ELIZA_BOOT_ENV_TEST_MANUAL).toBe("manual-value");

			delete process.env.ELIZA_BOOT_ENV_TEST_SOURCE;
			syncElizaEnvToBrand([
				["ELIZA_BOOT_ENV_TEST_TARGET", "ELIZA_BOOT_ENV_TEST_SOURCE"],
			]);

			expect(process.env.ELIZA_BOOT_ENV_TEST_TARGET).toBeUndefined();
		});
	});
});

// The boot-config store is shared across core/shared/ui bundles via the same
// global slot; getBootConfigStore must be write-once so a late window mirror
// cannot silently replace an already-established store (item #22 Done-when).
const STORE_KEY = Symbol.for("elizaos.app.boot-config");
const WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";
type Slot = Record<PropertyKey, unknown>;

describe("boot config store is write-once", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const tracked = [
		"ELIZA_ESTABLISHED_SRC",
		"ELIZA_WINDOW_SRC",
		"ELIZA_SEED_SRC",
		"ELIZA_ESTABLISHED_DST",
		"ELIZA_WINDOW_DST",
		"ELIZA_SEED_DST",
	];

	beforeEach(() => {
		const slot = globalThis as Slot;
		delete slot[STORE_KEY];
		delete slot[WINDOW_KEY];
		for (const key of tracked) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		const slot = globalThis as Slot;
		delete slot[STORE_KEY];
		delete slot[WINDOW_KEY];
		for (const key of tracked) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	it("the window-key mirror cannot replace an established store", () => {
		const slot = globalThis as Slot;
		slot[STORE_KEY] = {
			current: {
				envAliases: [["ELIZA_ESTABLISHED_SRC", "ELIZA_ESTABLISHED_DST"]],
			},
		};
		slot[WINDOW_KEY] = {
			envAliases: [["ELIZA_WINDOW_SRC", "ELIZA_WINDOW_DST"]],
		};
		process.env.ELIZA_ESTABLISHED_SRC = "established";
		process.env.ELIZA_WINDOW_SRC = "window";

		syncAppEnvToEliza();

		expect(process.env.ELIZA_ESTABLISHED_DST).toBe("established");
		expect(process.env.ELIZA_WINDOW_DST).toBeUndefined();
	});

	it("seeds the store from the window mirror when none exists yet", () => {
		const slot = globalThis as Slot;
		slot[WINDOW_KEY] = { envAliases: [["ELIZA_SEED_SRC", "ELIZA_SEED_DST"]] };
		process.env.ELIZA_SEED_SRC = "seed";

		syncAppEnvToEliza();

		expect(process.env.ELIZA_SEED_DST).toBe("seed");
		expect(slot[STORE_KEY]).toBeDefined();
	});

	it("stores the singleton through the ambient-context accessor", () => {
		const slot = globalThis as Slot;
		slot[WINDOW_KEY] = { envAliases: [["ELIZA_SEED_SRC", "ELIZA_SEED_DST"]] };

		// First access seeds the store via setAmbientSingleton(STORE_KEY, …).
		syncAppEnvToEliza();

		// The accessor and the raw global slot observe the same instance, proving
		// the store is read/written through ambient-context.ts, not a hand-rolled
		// globalThis[Symbol.for(...)] access.
		const viaAccessor = peekAmbientSingleton(STORE_KEY);
		expect(viaAccessor).toBeDefined();
		expect(viaAccessor).toBe(slot[STORE_KEY]);
	});
});

// resolveAliasedEnvValue is the additive read-side migration target (#12251
// slice 1): it resolves a brand<->eliza alias WITHOUT mutating process.env, so a
// read site can stop depending on the sync* mutation. These cases prove it
// resolves both directions, prefers the exact key, and never writes.
describe("resolveAliasedEnvValue (non-mutating alias reader)", () => {
	const BRAND = "MYBRAND_STATE_DIR";
	const ELIZA = "ELIZA_STATE_DIR";
	const OTHER = "MYBRAND_API_TOKEN";
	const ELIZA_OTHER = "ELIZA_API_TOKEN";
	const savedEnv: Record<string, string | undefined> = {};
	const tracked = [BRAND, ELIZA, OTHER, ELIZA_OTHER];
	const ALIASES = [
		[BRAND, ELIZA],
		[OTHER, ELIZA_OTHER],
	] as const;

	beforeEach(() => {
		for (const key of tracked) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of tracked) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	it("resolves the branded value when only the branded key is set", () => {
		process.env[BRAND] = "branded-state-dir";
		expect(resolveAliasedEnvValue(ELIZA, ALIASES)).toBe("branded-state-dir");
	});

	it("resolves the eliza value when only the eliza key is set", () => {
		process.env[ELIZA] = "eliza-state-dir";
		expect(resolveAliasedEnvValue(BRAND, ALIASES)).toBe("eliza-state-dir");
	});

	it("prefers the exact requested key over its alias partner", () => {
		process.env[BRAND] = "branded";
		process.env[ELIZA] = "eliza";
		expect(resolveAliasedEnvValue(ELIZA, ALIASES)).toBe("eliza");
		expect(resolveAliasedEnvValue(BRAND, ALIASES)).toBe("branded");
	});

	it("returns undefined when neither the key nor its alias is set", () => {
		expect(resolveAliasedEnvValue(ELIZA, ALIASES)).toBeUndefined();
	});

	it("does not resolve across unrelated alias pairs", () => {
		process.env[ELIZA_OTHER] = "token-value";
		// STATE_DIR must not pick up an API_TOKEN value from a different pair.
		expect(resolveAliasedEnvValue(ELIZA, ALIASES)).toBeUndefined();
	});

	it("never mutates process.env while resolving", () => {
		process.env[BRAND] = "branded-only";
		const before = { ...process.env };
		resolveAliasedEnvValue(ELIZA, ALIASES);
		resolveAliasedEnvValue(BRAND, ALIASES);
		// The eliza target must remain unset — the reader is additive, not a mirror.
		expect(process.env[ELIZA]).toBeUndefined();
		expect(process.env).toEqual(before);
	});

	it("treats an empty alias table as no aliasing", () => {
		process.env[BRAND] = "branded-only";
		expect(resolveAliasedEnvValue(ELIZA, [])).toBeUndefined();
		expect(resolveAliasedEnvValue(BRAND, [])).toBe("branded-only");
	});

	it("a blank canonical value does not shadow a present branded alias", () => {
		// Regression for the empty-string masking bug: the old sync path never
		// let a blank ELIZA_ value suppress a real branded alias, so the reader
		// must fall through to the branded value instead of resolving as unset.
		process.env[ELIZA] = "";
		process.env[BRAND] = "real-branded";
		expect(resolveAliasedEnvValue(ELIZA, ALIASES)).toBe("real-branded");

		process.env[ELIZA_OTHER] = "   ";
		process.env[OTHER] = "real-token";
		expect(resolveAliasedEnvValue(ELIZA_OTHER, ALIASES)).toBe("real-token");
	});

	it("returns undefined when both key and alias are blank", () => {
		process.env[ELIZA] = "";
		process.env[BRAND] = "  ";
		expect(resolveAliasedEnvValue(ELIZA, ALIASES)).toBeUndefined();
	});
});
