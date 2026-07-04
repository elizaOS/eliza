/**
 * Unit tests for embedding-preset/tier selection across hardware probes
 * (Apple Silicon / GPU / RAM). Pure-function assertions.
 */

import { describe, expect, it } from "vitest";
import type { HardwareProbe } from "../services/types";
import {
	EMBEDDING_PRESETS,
	selectEmbeddingPresetFromHardware,
	selectEmbeddingTierFromHardware,
} from "./embedding-presets";

function probe(overrides: Partial<HardwareProbe> = {}): HardwareProbe {
	return {
		totalRamGb: 32,
		freeRamGb: 20,
		gpu: null,
		cpuCores: 8,
		platform: "linux",
		arch: "x64",
		appleSilicon: false,
		recommendedBucket: "mid",
		source: "os-fallback",
		...overrides,
	};
}

describe("embedding preset hardware selection", () => {
	it.each([
		["cuda", "linux"],
		["vulkan", "linux"],
		["metal", "darwin"],
	] as const)("uses an accelerated preset when a %s backend is detected", (backend, platform) => {
		const hardware = probe({
			platform,
			gpu: { backend, totalVramGb: 8, freeVramGb: 7 },
		});

		expect(selectEmbeddingTierFromHardware(hardware)).toBe("standard");
		expect(selectEmbeddingPresetFromHardware(hardware).gpuLayers).toBe("auto");
	});

	it("keeps CPU fallback when no accelerator is detected", () => {
		expect(selectEmbeddingPresetFromHardware(probe()).gpuLayers).toBe(0);
	});

	it("keeps CPU fallback on low-RAM machines even with a GPU", () => {
		const hardware = probe({
			totalRamGb: 8,
			gpu: { backend: "cuda", totalVramGb: 8, freeVramGb: 7 },
		});

		expect(selectEmbeddingTierFromHardware(hardware)).toBe("fallback");
		expect(selectEmbeddingPresetFromHardware(hardware)).toBe(
			EMBEDDING_PRESETS.fallback,
		);
	});

	it("uses the performance tier on roomy accelerated hosts", () => {
		const hardware = probe({
			totalRamGb: 128,
			gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
		});

		expect(selectEmbeddingTierFromHardware(hardware)).toBe("performance");
		expect(selectEmbeddingPresetFromHardware(hardware).gpuLayers).toBe("auto");
	});
});
