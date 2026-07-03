import { describe, expect, it } from "vitest";
import {
	extractLayerCount,
	isConstrainedMobilePlatform,
	MOBILE_N_UBATCH,
	MobileMemoryAdmissionError,
	planMobileGpuAdmission,
} from "../memory-admission";

const MIB = 1024 * 1024;
const GIB_8 = 8 * 1024 * MIB;

describe("planMobileGpuAdmission", () => {
	it("admits the measured A18 configuration at full offload (#11612 fit math)", () => {
		// iPhone 16 Pro Max: weights 4722 MiB, 36 layers, 8 GiB physical RAM.
		const admission = planMobileGpuAdmission({
			weightsBytes: 4722 * MIB,
			layerCount: 36,
			totalRamBytes: GIB_8,
		});
		expect(admission.fullOffload).toBe(true);
		expect(admission.nGpuLayers).toBe(999);
		expect(admission.nUbatch).toBe(MOBILE_N_UBATCH);
		expect(admission.nBatch).toBe(MOBILE_N_UBATCH);
		// Budget = 2/3 of physical RAM (jetsam working set) → 5461 MiB on 8 GiB.
		expect(admission.budgetMib).toBe(5461);
		// Compute buffer at n_ubatch 256 ≈ 260 MiB (1037 MiB measured at 1024).
		expect(admission.computeMib).toBe(260);
		// Total wired fit stays under the working set: 4722 + 260 + 64 < 5461.
		expect(
			admission.weightsMib + admission.computeMib + admission.kvMib,
		).toBeLessThan(admission.budgetMib);
	});

	it("rejects the pre-fix configuration: n_ubatch 1024 compute buffer overflows the working set", () => {
		// Regression pin for the original OOM: 4722 + 1037 + KV > 5461 —
		// the plan at n_ubatch 256 must be strictly under budget while the
		// same weights with the old 1037 MiB compute buffer are over it.
		const admission = planMobileGpuAdmission({
			weightsBytes: 4722 * MIB,
			layerCount: 36,
			totalRamBytes: GIB_8,
		});
		const oldComputeMib = 1037;
		expect(
			admission.weightsMib + oldComputeMib + admission.kvMib,
		).toBeGreaterThan(admission.budgetMib);
	});

	it("reduces n_gpu_layers proportionally when weights alone exceed the budget", () => {
		const admission = planMobileGpuAdmission({
			weightsBytes: 6000 * MIB,
			layerCount: 36,
			totalRamBytes: GIB_8,
		});
		expect(admission.fullOffload).toBe(false);
		expect(admission.nGpuLayers).toBeGreaterThan(0);
		expect(admission.nGpuLayers).toBeLessThan(36);
		// The wired fraction of the weights must fit the budget.
		const wiredWeightsMib =
			(admission.weightsMib / admission.layerCount) * admission.nGpuLayers;
		expect(
			wiredWeightsMib + admission.computeMib + admission.kvMib,
		).toBeLessThanOrEqual(admission.budgetMib);
	});

	it("falls back to the eliza-1 layer count when GGUF metadata is unreadable", () => {
		const admission = planMobileGpuAdmission({
			weightsBytes: 6000 * MIB,
			layerCount: null,
			totalRamBytes: GIB_8,
		});
		expect(admission.layerCount).toBe(36);
	});

	it("throws MobileMemoryAdmissionError when not even zero offload fits", () => {
		expect(() =>
			planMobileGpuAdmission({
				weightsBytes: 4722 * MIB,
				layerCount: 36,
				totalRamBytes: 256 * MIB,
			}),
		).toThrow(MobileMemoryAdmissionError);
	});
});

describe("extractLayerCount", () => {
	it("reads <arch>.block_count from GGUF metadata", () => {
		expect(extractLayerCount({ "gemma3.block_count": 36 })).toBe(36);
		expect(extractLayerCount({ "llama.block_count": "48" })).toBe(48);
	});

	it("returns null for missing or invalid metadata", () => {
		expect(extractLayerCount(null)).toBeNull();
		expect(extractLayerCount({})).toBeNull();
		expect(
			extractLayerCount({ "gemma3.block_count": "not-a-number" }),
		).toBeNull();
		expect(extractLayerCount({ "gemma3.block_count": 0 })).toBeNull();
	});
});

describe("isConstrainedMobilePlatform", () => {
	it("is true only for ELIZA_PLATFORM=ios|android", () => {
		expect(isConstrainedMobilePlatform({ ELIZA_PLATFORM: "ios" })).toBe(true);
		expect(isConstrainedMobilePlatform({ ELIZA_PLATFORM: "Android" })).toBe(
			true,
		);
		expect(isConstrainedMobilePlatform({ ELIZA_PLATFORM: "darwin" })).toBe(
			false,
		);
		expect(isConstrainedMobilePlatform({})).toBe(false);
	});
});
