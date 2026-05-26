import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ELIZA_1_RELEASE_TIER_IDS,
	isDefaultEligibleId,
	MODEL_CATALOG,
} from "./catalog";
import { runDflashDoctor } from "./dflash-doctor";

vi.mock("./registry", () => ({
	listInstalledModels: vi.fn(async () => []),
}));

vi.mock("./dflash-server", () => ({
	dflashLlamaServer: {
		hasLoadedModel: () => false,
		getMetrics: async () => null,
	},
	getDflashRuntimeStatus: () => ({
		enabled: false,
		required: false,
		binaryPath: null,
		reason: "mocked in dflash-doctor.test",
		capabilities: null,
	}),
	validateDflashDrafterCompatibility: () => ({
		compatible: true,
		reason: "mocked in dflash-doctor.test",
	}),
}));

afterEach(() => {
	vi.clearAllMocks();
});

describe("runDflashDoctor — tokenizer parity check", () => {
	it("does not emit tokenizer-parity checks without published DFlash pairs", async () => {
		const dflashTargets = MODEL_CATALOG.filter((m) => m.runtime?.dflash);
		expect(dflashTargets).toEqual([]);

		const report = await runDflashDoctor();
		const tokenizerChecks = report.checks.filter((c) =>
			c.id.endsWith(":tokenizer"),
		);
		expect(tokenizerChecks).toEqual([]);
	});

	it("every default-eligible Eliza-1 tier uses native MTP instead of DFlash", async () => {
		for (const id of ELIZA_1_RELEASE_TIER_IDS) {
			const model = MODEL_CATALOG.find((m) => m.id === id);
			expect(model, `${id} missing from catalog`).toBeDefined();
			expect(isDefaultEligibleId(id), `${id} should be default-eligible`).toBe(
				true,
			);
			expect(model?.runtime?.mtp?.specType, `${id} mtp`).toBe("draft-mtp");
			expect(model?.runtime?.dflash, `${id} dflash`).toBeUndefined();
			expect(model?.companionModelIds, `${id} companions`).toBeUndefined();
		}
	});
});
