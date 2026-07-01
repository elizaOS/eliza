import { describe, expect, it } from "vitest";
import { syncBrandEnvToEliza, syncElizaEnvToBrand } from "./boot-env";

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
			"MILADY_BOOT_ENV_TEST_SOURCE",
			"MILADY_BOOT_ENV_TEST_MISSING",
			"ELIZA_BOOT_ENV_TEST_TARGET",
			"ELIZA_BOOT_ENV_TEST_MANUAL",
		];
		withCleanEnv(keys, () => {
			process.env.MILADY_BOOT_ENV_TEST_SOURCE = "brand-value";
			process.env.ELIZA_BOOT_ENV_TEST_MANUAL = "manual-value";

			syncBrandEnvToEliza([
				["MILADY_BOOT_ENV_TEST_SOURCE", "ELIZA_BOOT_ENV_TEST_TARGET"],
				["MILADY_BOOT_ENV_TEST_MISSING", "ELIZA_BOOT_ENV_TEST_MANUAL"],
			]);

			expect(process.env.ELIZA_BOOT_ENV_TEST_TARGET).toBe("brand-value");
			expect(process.env.ELIZA_BOOT_ENV_TEST_MANUAL).toBe("manual-value");

			delete process.env.MILADY_BOOT_ENV_TEST_SOURCE;
			syncBrandEnvToEliza([
				["MILADY_BOOT_ENV_TEST_SOURCE", "ELIZA_BOOT_ENV_TEST_TARGET"],
			]);

			expect(process.env.ELIZA_BOOT_ENV_TEST_TARGET).toBeUndefined();
		});
	});

	it("mirrors Eliza env to branded env and clears stale mirrored targets", () => {
		const keys = [
			"MILADY_BOOT_ENV_TEST_TARGET",
			"MILADY_BOOT_ENV_TEST_MANUAL",
			"ELIZA_BOOT_ENV_TEST_SOURCE",
			"ELIZA_BOOT_ENV_TEST_MISSING",
		];
		withCleanEnv(keys, () => {
			process.env.ELIZA_BOOT_ENV_TEST_SOURCE = "eliza-value";
			process.env.MILADY_BOOT_ENV_TEST_MANUAL = "manual-value";

			syncElizaEnvToBrand([
				["MILADY_BOOT_ENV_TEST_TARGET", "ELIZA_BOOT_ENV_TEST_SOURCE"],
				["MILADY_BOOT_ENV_TEST_MANUAL", "ELIZA_BOOT_ENV_TEST_MISSING"],
			]);

			expect(process.env.MILADY_BOOT_ENV_TEST_TARGET).toBe("eliza-value");
			expect(process.env.MILADY_BOOT_ENV_TEST_MANUAL).toBe("manual-value");

			delete process.env.ELIZA_BOOT_ENV_TEST_SOURCE;
			syncElizaEnvToBrand([
				["MILADY_BOOT_ENV_TEST_TARGET", "ELIZA_BOOT_ENV_TEST_SOURCE"],
			]);

			expect(process.env.MILADY_BOOT_ENV_TEST_TARGET).toBeUndefined();
		});
	});
});
