import { findCatalogModel, GPU_PROFILES } from "@elizaos/shared";
import { describe, expect, it } from "vitest";

describe("catalog gpuProfile wiring", () => {
	it("eliza-1-27b demands the active long-context kernel set (turbo3_tcq)", () => {
		const bundle = findCatalogModel("eliza-1-27b");
		expect(bundle).toBeDefined();
		if (!bundle) return;
		expect(bundle.contextLength).toBe(131072);
		const required = bundle.runtime?.optimizations?.requiresKernel ?? [];
		// Every kernel needed for the active 128k-context quantized KV tier.
		for (const k of [
			"dflash",
			"turbo3",
			"turbo4",
			"qjl_full",
			"polarquant",
			"turbo3_tcq",
		]) {
			expect(required).toContain(k);
		}
	});

	it("eliza-1-27b maps to the rtx-4090 profile", () => {
		const bundle = findCatalogModel("eliza-1-27b");
		expect(bundle?.gpuProfile).toBe("rtx-4090");
	});

	it("eliza-1-9b maps to the rtx-3090 profile", () => {
		const bundle = findCatalogModel("eliza-1-9b");
		expect(bundle?.gpuProfile).toBe("rtx-3090");
	});

	it("every recommended bundle id on a profile exists in the catalog", () => {
		for (const profile of Object.values(GPU_PROFILES)) {
			for (const bundleId of profile.recommendedBundles) {
				const bundle = findCatalogModel(bundleId);
				expect(bundle, `bundle ${bundleId} for ${profile.id}`).toBeDefined();
			}
		}
	});

	it("h200 profile's primary bundle covers the maximum active context window", () => {
		const profile = GPU_PROFILES.h200;
		const primary = findCatalogModel(profile.recommendedBundles[0]);
		expect(primary?.contextLength).toBe(profile.contextSize);
	});
});
