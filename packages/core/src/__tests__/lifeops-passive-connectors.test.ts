import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lifeOpsPassiveConnectorsEnabled } from "../lifeops-passive-connectors";

const LIFEOPS_PLUGIN = "@elizaos/plugin-personal-assistant";
const OTHER_PLUGIN = "@elizaos/plugin-discord";

function makeRuntime(opts: { setting?: string | boolean; plugins?: string[] }) {
	return {
		getSetting: (key: string) => {
			if (
				(key === "ELIZA_LIFEOPS_PASSIVE_CONNECTORS" ||
					key === "LIFEOPS_PASSIVE_CONNECTORS") &&
				opts.setting !== undefined
			) {
				return opts.setting;
			}
			return undefined;
		},
		plugins: (opts.plugins ?? []).map((name) => ({ name })),
	};
}

describe("lifeOpsPassiveConnectorsEnabled", () => {
	// Isolate from real process.env across tests
	let savedEnv: Record<string, string | undefined>;
	beforeEach(() => {
		savedEnv = {};
		for (const key of [
			"ELIZA_LIFEOPS_PASSIVE_CONNECTORS",
			"LIFEOPS_PASSIVE_CONNECTORS",
		]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});
	afterEach(() => {
		for (const [key, val] of Object.entries(savedEnv)) {
			if (val === undefined) delete process.env[key];
			else process.env[key] = val;
		}
	});

	describe("default behaviour (no env var, no runtime setting)", () => {
		it("returns false when no runtime is provided", () => {
			expect(lifeOpsPassiveConnectorsEnabled()).toBe(false);
		});

		it("returns false when runtime has no plugins array", () => {
			expect(
				lifeOpsPassiveConnectorsEnabled({ getSetting: () => undefined }),
			).toBe(false);
		});

		it("returns false when runtime has an empty plugins array", () => {
			expect(
				lifeOpsPassiveConnectorsEnabled(makeRuntime({ plugins: [] })),
			).toBe(false);
		});

		it("returns false when only unrelated plugins are loaded", () => {
			expect(
				lifeOpsPassiveConnectorsEnabled(
					makeRuntime({ plugins: [OTHER_PLUGIN] }),
				),
			).toBe(false);
		});

		it("returns true when plugin-personal-assistant is loaded", () => {
			expect(
				lifeOpsPassiveConnectorsEnabled(
					makeRuntime({ plugins: [LIFEOPS_PLUGIN] }),
				),
			).toBe(true);
		});

		it("returns true when plugin-personal-assistant is among other plugins", () => {
			expect(
				lifeOpsPassiveConnectorsEnabled(
					makeRuntime({ plugins: [OTHER_PLUGIN, LIFEOPS_PLUGIN] }),
				),
			).toBe(true);
		});
	});

	describe("explicit runtime setting overrides plugin detection", () => {
		it("returns false when setting is 'false' even with LifeOps plugin loaded", () => {
			expect(
				lifeOpsPassiveConnectorsEnabled(
					makeRuntime({ setting: "false", plugins: [LIFEOPS_PLUGIN] }),
				),
			).toBe(false);
		});

		it("returns true when setting is 'true' even without LifeOps plugin", () => {
			expect(
				lifeOpsPassiveConnectorsEnabled(
					makeRuntime({ setting: "true", plugins: [] }),
				),
			).toBe(true);
		});

		it("recognises boolean false setting", () => {
			expect(
				lifeOpsPassiveConnectorsEnabled(makeRuntime({ setting: false })),
			).toBe(false);
		});

		it("recognises boolean true setting", () => {
			expect(
				lifeOpsPassiveConnectorsEnabled(makeRuntime({ setting: true })),
			).toBe(true);
		});
	});

	describe("env var overrides plugin detection", () => {
		it("returns false when env ELIZA_LIFEOPS_PASSIVE_CONNECTORS=false even with plugin loaded", () => {
			expect(
				lifeOpsPassiveConnectorsEnabled(
					makeRuntime({ plugins: [LIFEOPS_PLUGIN] }),
					{ ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false" },
				),
			).toBe(false);
		});

		it("returns true when env ELIZA_LIFEOPS_PASSIVE_CONNECTORS=true without plugin", () => {
			expect(
				lifeOpsPassiveConnectorsEnabled(makeRuntime({ plugins: [] }), {
					ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "true",
				}),
			).toBe(true);
		});

		it("recognises legacy LIFEOPS_PASSIVE_CONNECTORS env var", () => {
			expect(
				lifeOpsPassiveConnectorsEnabled(makeRuntime({ plugins: [] }), {
					LIFEOPS_PASSIVE_CONNECTORS: "true",
				}),
			).toBe(true);
		});
	});

	describe("null / undefined runtime", () => {
		it("handles null runtime gracefully", () => {
			expect(lifeOpsPassiveConnectorsEnabled(null)).toBe(false);
		});

		it("handles undefined runtime gracefully", () => {
			expect(lifeOpsPassiveConnectorsEnabled(undefined)).toBe(false);
		});
	});
});
