import { describe, expect, it } from "vitest";
import {
	detectEmbeddingPresetForHardware,
	detectEmbeddingTierForHardware,
} from "./embedding-presets";

describe("embedding preset detection", () => {
	it.each([
		"metal",
		"cuda",
		"vulkan",
	] as const)("uses the accelerated preset for %s hosts", (gpuBackend) => {
		expect(detectEmbeddingTierForHardware({ totalRamGB: 32, gpuBackend })).toBe(
			"standard",
		);
		expect(
			detectEmbeddingPresetForHardware({ totalRamGB: 32, gpuBackend })
				.gpuLayers,
		).toBe("auto");
	});

	it("keeps CPU fallback for CPU-only hosts", () => {
		expect(
			detectEmbeddingPresetForHardware({
				totalRamGB: 32,
				gpuBackend: null,
			}).gpuLayers,
		).toBe(0);
	});

	it("keeps CPU fallback for low-RAM hosts even when a GPU is present", () => {
		expect(
			detectEmbeddingTierForHardware({
				totalRamGB: 8,
				gpuBackend: "cuda",
			}),
		).toBe("fallback");
	});

	it("uses the performance preset only on large accelerated hosts", () => {
		expect(
			detectEmbeddingTierForHardware({
				totalRamGB: 128,
				gpuBackend: "cuda",
			}),
		).toBe("performance");
		expect(
			detectEmbeddingTierForHardware({
				totalRamGB: 128,
				gpuBackend: null,
			}),
		).toBe("fallback");
	});
});
