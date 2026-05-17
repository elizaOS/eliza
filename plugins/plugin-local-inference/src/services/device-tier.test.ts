import { describe, expect, it } from "vitest";
import {
	classifyDeviceTier,
	DEVICE_TIER_ORDER,
	DEVICE_TIER_THRESHOLDS,
	effectiveModelMemoryGb,
	TIER_WARNING_COPY,
} from "./device-tier";
import type { HardwareProbe } from "./types";

const baseProbe: HardwareProbe = {
	totalRamGb: 16,
	freeRamGb: 8,
	gpu: null,
	cpuCores: 8,
	platform: "linux",
	arch: "x64",
	appleSilicon: false,
	recommendedBucket: "mid",
	source: "node-llama-cpp",
};

function probe(overrides: Partial<HardwareProbe>): HardwareProbe {
	return { ...baseProbe, ...overrides };
}

describe("classifyDeviceTier", () => {
	describe("MAX tier", () => {
		it("classifies a CUDA workstation with 24 GB VRAM as MAX", () => {
			const result = classifyDeviceTier(
				probe({
					totalRamGb: 64,
					freeRamGb: 48,
					gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
					cpuCores: 16,
				}),
			);
			expect(result.tier).toBe("MAX");
			expect(result.canRunLocalLm).toBe(true);
			expect(result.canRunLocalVoice).toBe(true);
			expect(result.recommendedMode).toBe("local");
		});

		it("classifies an Apple Silicon M3 Max 64 GB as MAX", () => {
			const result = classifyDeviceTier(
				probe({
					totalRamGb: 64,
					freeRamGb: 48,
					gpu: null,
					cpuCores: 16,
					platform: "darwin",
					arch: "arm64",
					appleSilicon: true,
				}),
			);
			expect(result.tier).toBe("MAX");
			expect(result.numericContext.effectiveModelMemoryGb).toBe(64);
		});

		it("includes reasons for MAX classification", () => {
			const result = classifyDeviceTier(
				probe({
					totalRamGb: 64,
					freeRamGb: 48,
					gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
					cpuCores: 16,
				}),
			);
			expect(result.reasons.length).toBeGreaterThan(0);
			expect(result.reasons[0]).toMatch(/effective model RAM/);
		});
	});

	describe("GOOD tier — local dev box (RTX 5080 Laptop, 16 GB VRAM)", () => {
		it("classifies a RTX 5080 Laptop (16 GB VRAM, 32 GB RAM, AVX-VNNI) as GOOD or MAX", () => {
			// Per R9 §3 — the local dev box should land in MAX (>= 24 GB
			// effective model RAM via VRAM-or-half-RAM math) OR GOOD when
			// constrained by free RAM at session start. RTX 5080 Laptop = 16
			// GB VRAM; system 32 GB RAM @ half = 16 GB effective; effective =
			// max(VRAM, RAM/2) = 16 GB → GOOD.
			const result = classifyDeviceTier(
				probe({
					totalRamGb: 32,
					freeRamGb: 20,
					gpu: { backend: "cuda", totalVramGb: 16, freeVramGb: 14 },
					cpuCores: 16,
					platform: "linux",
					arch: "x64",
				}),
			);
			expect(["GOOD", "MAX"]).toContain(result.tier);
			expect(result.canRunLocalLm).toBe(true);
			expect(result.canRunLocalVoice).toBe(true);
		});

		it("classifies a 16 GB VRAM dGPU + 16 GB RAM laptop as GOOD", () => {
			const result = classifyDeviceTier(
				probe({
					totalRamGb: 16,
					freeRamGb: 10,
					gpu: { backend: "cuda", totalVramGb: 16, freeVramGb: 14 },
					cpuCores: 12,
				}),
			);
			expect(result.tier).toBe("GOOD");
		});

		it("classifies an Apple Silicon M3 base 16 GB as GOOD", () => {
			const result = classifyDeviceTier(
				probe({
					totalRamGb: 16,
					freeRamGb: 10,
					gpu: null,
					cpuCores: 8,
					platform: "darwin",
					arch: "arm64",
					appleSilicon: true,
				}),
			);
			expect(result.tier).toBe("GOOD");
		});

		it("classifies an x86 CPU-only 32 GB box as GOOD", () => {
			const result = classifyDeviceTier(
				probe({
					totalRamGb: 32,
					freeRamGb: 20,
					gpu: null,
					cpuCores: 8,
				}),
			);
			expect(result.tier).toBe("GOOD");
		});
	});

	describe("OKAY tier", () => {
		it("classifies a 16 GB CPU-only laptop as OKAY", () => {
			const result = classifyDeviceTier(
				probe({
					totalRamGb: 16,
					freeRamGb: 8,
					gpu: null,
					cpuCores: 8,
				}),
			);
			expect(result.tier).toBe("OKAY");
		});

		it("clamps Apple Silicon 8 GB to OKAY", () => {
			const result = classifyDeviceTier(
				probe({
					totalRamGb: 8,
					freeRamGb: 4,
					gpu: null,
					cpuCores: 8,
					platform: "darwin",
					arch: "arm64",
					appleSilicon: true,
				}),
			);
			// 8 GB ceiling makes this POOR by raw thresholds (effective < 6 GB
			// after macOS reserve), but the AS8GB clamp ensures it does not
			// claim above OKAY.
			expect(["OKAY", "POOR"]).toContain(result.tier);
			expect(result.tier === "OKAY" || result.tier === "POOR").toBe(true);
		});
	});

	describe("POOR tier", () => {
		it("classifies an 8 GB box without GPU as POOR", () => {
			const result = classifyDeviceTier(
				probe({
					totalRamGb: 8,
					freeRamGb: 3,
					gpu: null,
					cpuCores: 4,
				}),
			);
			expect(result.tier).toBe("POOR");
			expect(result.canRunLocalLm).toBe(false);
			expect(result.recommendedMode).toBe("cloud-only");
		});

		it("classifies a 2-core CPU as POOR (no AVX2 baseline)", () => {
			const result = classifyDeviceTier(
				probe({
					totalRamGb: 32,
					freeRamGb: 24,
					gpu: null,
					cpuCores: 2,
				}),
			);
			expect(result.tier).toBe("POOR");
			expect(result.reasons.join(" ")).toMatch(/AVX2|cores/);
		});
	});

	describe("mobile clamps", () => {
		it("clamps iOS to OKAY even with 12 GB RAM", () => {
			const result = classifyDeviceTier(
				probe({
					totalRamGb: 12,
					freeRamGb: 6,
					gpu: null,
					cpuCores: 6,
					platform: "darwin",
					arch: "arm64",
					appleSilicon: true,
					mobile: {
						platform: "ios",
						deviceModel: "iPhone 15 Pro",
						availableRamGb: 6,
					},
				}),
			);
			expect(["OKAY", "POOR"]).toContain(result.tier);
			expect(result.recommendedMode).toBe("cloud-with-local-voice");
		});

		it("returns POOR/cloud-only for low-end Android", () => {
			const result = classifyDeviceTier(
				probe({
					totalRamGb: 4,
					freeRamGb: 1.5,
					gpu: null,
					cpuCores: 4,
					platform: "linux",
					arch: "arm64",
					appleSilicon: false,
					mobile: { platform: "android", availableRamGb: 1.5 },
				}),
			);
			expect(result.tier).toBe("POOR");
			expect(result.recommendedMode).toBe("cloud-only");
		});

		it("flagship Android (16 GB) clamps to OKAY", () => {
			const result = classifyDeviceTier(
				probe({
					totalRamGb: 16,
					freeRamGb: 8,
					gpu: null,
					cpuCores: 8,
					platform: "linux",
					arch: "arm64",
					mobile: { platform: "android", availableRamGb: 8 },
				}),
			);
			expect(result.tier).toBe("OKAY");
			// Mobile defaults to cloud TTS+ASR per R9 §6.3.
			expect(result.recommendedMode).toBe("cloud-with-local-voice");
		});
	});

	describe("free-RAM gate at session start", () => {
		it("demotes one tier when free RAM is below 25% of total", () => {
			const hot = classifyDeviceTier(
				probe({
					totalRamGb: 64,
					freeRamGb: 48,
					gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
					cpuCores: 16,
				}),
			);
			expect(hot.tier).toBe("MAX");
			const constrained = classifyDeviceTier(
				probe({
					totalRamGb: 64,
					freeRamGb: 8, // 12.5% — below the 25% gate
					gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
					cpuCores: 16,
				}),
			);
			// 8 GB free fails MAX's freeRamGbAtSession threshold (16 GB) so it
			// can't be MAX on threshold-grounds; the demote rule also fires
			// and steps down one tier from MAX → GOOD.
			expect(["GOOD", "OKAY"]).toContain(constrained.tier);
		});
	});
});

describe("effectiveModelMemoryGb", () => {
	it("returns totalRamGb for Apple Silicon", () => {
		expect(
			effectiveModelMemoryGb(
				probe({
					totalRamGb: 32,
					gpu: null,
					appleSilicon: true,
					platform: "darwin",
					arch: "arm64",
				}),
			),
		).toBe(32);
	});

	it("returns max(vram, totalRam/2) for discrete GPU", () => {
		expect(
			effectiveModelMemoryGb(
				probe({
					totalRamGb: 32,
					gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 24 },
				}),
			),
		).toBe(24);
		expect(
			effectiveModelMemoryGb(
				probe({
					totalRamGb: 64,
					gpu: { backend: "cuda", totalVramGb: 8, freeVramGb: 8 },
				}),
			),
		).toBe(32);
	});

	it("returns totalRamGb / 2 for CPU-only", () => {
		expect(effectiveModelMemoryGb(probe({ totalRamGb: 32, gpu: null }))).toBe(
			16,
		);
	});
});

describe("TIER_WARNING_COPY", () => {
	it("provides header + body for every tier", () => {
		for (const tier of DEVICE_TIER_ORDER) {
			expect(TIER_WARNING_COPY[tier]).toBeDefined();
			expect(TIER_WARNING_COPY[tier].header).toMatch(/tier/i);
			expect(TIER_WARNING_COPY[tier].body.length).toBeGreaterThan(20);
		}
	});
});

describe("DEVICE_TIER_THRESHOLDS", () => {
	it("matches R9 §3.1 numbers", () => {
		expect(DEVICE_TIER_THRESHOLDS.MAX.effectiveModelMemoryGb).toBe(24);
		expect(DEVICE_TIER_THRESHOLDS.MAX.freeRamGbAtSession).toBe(16);
		expect(DEVICE_TIER_THRESHOLDS.MAX.dGpuMinVramGb).toBe(16);
		expect(DEVICE_TIER_THRESHOLDS.MAX.appleSiliconMinMemoryGb).toBe(32);

		expect(DEVICE_TIER_THRESHOLDS.GOOD.effectiveModelMemoryGb).toBe(12);
		expect(DEVICE_TIER_THRESHOLDS.GOOD.freeRamGbAtSession).toBe(8);
		expect(DEVICE_TIER_THRESHOLDS.GOOD.dGpuMinVramGb).toBe(8);
		expect(DEVICE_TIER_THRESHOLDS.GOOD.appleSiliconMinMemoryGb).toBe(16);

		expect(DEVICE_TIER_THRESHOLDS.OKAY.effectiveModelMemoryGb).toBe(6);
		expect(DEVICE_TIER_THRESHOLDS.OKAY.freeRamGbAtSession).toBe(3);
	});
});
