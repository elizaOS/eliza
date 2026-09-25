import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAliasedEnvValue as resolveRuntimeEnv } from "../boot-env.js";
import {
	DEFAULT_BOOT_CONFIG,
	getBootConfig,
	resolveAliasedEnvValue,
	setBootConfig,
} from "./boot-config-store.js";

const storeKey = Symbol.for("elizaos.app.boot-config");
const mirrorKey = "__ELIZAOS_APP_BOOT_CONFIG__";
const slot = globalThis as Record<PropertyKey, unknown>;
let previousStore: PropertyDescriptor | undefined;
let previousMirror: PropertyDescriptor | undefined;

beforeEach(() => {
	previousStore = Object.getOwnPropertyDescriptor(slot, storeKey);
	previousMirror = Object.getOwnPropertyDescriptor(slot, mirrorKey);
	delete slot[storeKey];
	delete slot[mirrorKey];
});

afterEach(() => {
	for (const [key, descriptor] of [
		[storeKey, previousStore],
		[mirrorKey, previousMirror],
	] as const) {
		if (descriptor) Object.defineProperty(slot, key, descriptor);
		else delete slot[key];
	}
});

describe("process boot configuration", () => {
	it("ignores browser bootstrap mirrors without reading or overwriting them", () => {
		Object.defineProperty(slot, mirrorKey, {
			configurable: true,
			get() {
				throw new Error("browser mirror read");
			},
			set() {
				throw new Error("browser mirror write");
			},
		});
		expect(getBootConfig()).toBe(DEFAULT_BOOT_CONFIG);
		const config = { branding: {}, apiBase: "http://localhost:3000" };
		setBootConfig(config);
		expect(getBootConfig()).toBe(config);
	});

	it("preserves host-installed state and shares updates with runtime env resolution", () => {
		const config = {
			branding: {},
			envAliases: [["CUSTOM_FLAG", "ELIZA_FLAG"]] as const,
		};
		const store = { current: config };
		slot[storeKey] = store;
		expect(getBootConfig()).toBe(config);
		const env = { CUSTOM_FLAG: "enabled" };
		expect(resolveAliasedEnvValue("ELIZA_FLAG", undefined, env)).toBe(
			"enabled",
		);
		expect(resolveRuntimeEnv("ELIZA_FLAG", undefined, env)).toBe("enabled");
		const next = { branding: {}, envAliases: [] };
		setBootConfig(next);
		expect(store.current).toBe(next);
		expect(resolveRuntimeEnv("ELIZA_FLAG", undefined, env)).toBeUndefined();
		expect(
			resolveAliasedEnvValue("ELIZA_FLAG", undefined, null),
		).toBeUndefined();
	});
});
