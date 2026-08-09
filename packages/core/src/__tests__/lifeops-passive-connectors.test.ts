import { describe, expect, it } from "vitest";
import { lifeOpsPassiveConnectorsEnabled } from "../lifeops-passive-connectors";

const LIFEOPS_PLUGIN = "@elizaos/plugin-personal-assistant";
const DISCORD_PLUGIN = "@elizaos/plugin-discord";

function makeRuntime(options: {
	setting?: string | boolean | number;
	plugins?: string[];
}) {
	return {
		getSetting: (key: string) => {
			if (
				(key === "ELIZA_LIFEOPS_PASSIVE_CONNECTORS" ||
					key === "LIFEOPS_PASSIVE_CONNECTORS") &&
				options.setting !== undefined
			) {
				return options.setting;
			}
			return undefined;
		},
		plugins: (options.plugins ?? []).map((name) => ({ name })),
	};
}

describe("lifeOpsPassiveConnectorsEnabled", () => {
	it("defaults to active connector replies when no runtime is available", () => {
		expect(lifeOpsPassiveConnectorsEnabled()).toBe(false);
		expect(lifeOpsPassiveConnectorsEnabled(undefined, {})).toBe(false);
	});

	it("defaults standalone runtimes without LifeOps to active connector replies", () => {
		expect(lifeOpsPassiveConnectorsEnabled(makeRuntime({ plugins: [] }))).toBe(
			false,
		);
		expect(
			lifeOpsPassiveConnectorsEnabled(
				makeRuntime({ plugins: [DISCORD_PLUGIN] }),
			),
		).toBe(false);
	});

	it("defaults LifeOps runtimes to passive connector ingestion", () => {
		expect(
			lifeOpsPassiveConnectorsEnabled(
				makeRuntime({ plugins: [DISCORD_PLUGIN, LIFEOPS_PLUGIN] }),
			),
		).toBe(true);
	});

	it("keeps null runtime conservative for pre-runtime connector bootstrap checks", () => {
		expect(lifeOpsPassiveConnectorsEnabled(null, {})).toBe(true);
	});

	it("lets runtime settings override plugin detection", () => {
		expect(
			lifeOpsPassiveConnectorsEnabled(
				makeRuntime({ setting: "false", plugins: [LIFEOPS_PLUGIN] }),
			),
		).toBe(false);
		expect(
			lifeOpsPassiveConnectorsEnabled(
				makeRuntime({ setting: "true", plugins: [DISCORD_PLUGIN] }),
			),
		).toBe(true);
		expect(lifeOpsPassiveConnectorsEnabled(makeRuntime({ setting: 0 }))).toBe(
			false,
		);
	});

	it("lets env settings override plugin detection when runtime settings are absent", () => {
		expect(
			lifeOpsPassiveConnectorsEnabled(
				makeRuntime({ plugins: [LIFEOPS_PLUGIN] }),
				{ ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "off" },
			),
		).toBe(false);
		expect(
			lifeOpsPassiveConnectorsEnabled(makeRuntime({ plugins: [] }), {
				LIFEOPS_PASSIVE_CONNECTORS: "yes",
			}),
		).toBe(true);
	});
});
