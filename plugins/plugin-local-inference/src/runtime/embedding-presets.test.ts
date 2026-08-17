/**
 * Unit tests for embedding-preset/tier selection across hardware probes
 * (Apple Silicon / GPU / RAM). Pure-function assertions.
 */

import {
	CANONICAL_EMBEDDING_GGUF_SHA256,
	CANONICAL_EMBEDDING_GGUF_SIZE_BYTES,
} from "@elizaos/core";
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
	it("pins every hardware tier to the same canonical BGE-small vector space", () => {
		for (const preset of Object.values(EMBEDDING_PRESETS)) {
			expect(preset.model).toBe("bge-small-en-v1.5-q4_k_m.gguf");
			expect(preset.modelRepo).toBe("CompendiumLabs/bge-small-en-v1.5-gguf");
			expect(preset.dimensions).toBe(384);
			expect(preset.contextSize).toBe(512);
			expect(preset.expectedSizeBytes).toBe(
				CANONICAL_EMBEDDING_GGUF_SIZE_BYTES,
			);
			expect(preset.sha256).toBe(CANONICAL_EMBEDDING_GGUF_SHA256);
		}
	});

	it.each([
		["cuda", "linux"],
		["vulkan", "linux"],
		["metal", "darwin"],
	] as const)(
		"uses an accelerated preset when a %s backend is detected",
		(backend, platform) => {
			const hardware = probe({
				platform,
				gpu: { backend, totalVramGb: 8, freeVramGb: 7 },
			});

			expect(selectEmbeddingTierFromHardware(hardware)).toBe("standard");
			expect(selectEmbeddingPresetFromHardware(hardware).gpuLayers).toBe(
				"auto",
			);
		},
	);

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
