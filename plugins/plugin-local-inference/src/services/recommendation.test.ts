import type { CatalogModel, HardwareProbe } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
	catalogDownloadSizeBytes,
	catalogDownloadSizeGb,
	classifyRecommendationPlatform,
	deviceCapsFromProbe,
	selectBestQuantizationVariant,
} from "./recommendation.js";

/**
 * Pure recommendation helpers that decide which model the device can run.
 * Platform/backend classification drives the slot ladders and the on-device
 * default gate (#8848), so the branch table is pinned here.
 */

const probe = (o: Partial<HardwareProbe> = {}): HardwareProbe =>
	({
		totalRamGb: 16,
		freeRamGb: 8,
		gpu: null,
		cpuCores: 8,
		platform: "linux",
		arch: "x64",
		appleSilicon: false,
		recommendedBucket: "medium",
		source: "os-fallback",
		...o,
	}) as HardwareProbe;

const metalGpu = { backend: "metal" as const, totalVramGb: 24, freeVramGb: 20 };
const cudaGpu = { backend: "cuda" as const, totalVramGb: 24, freeVramGb: 20 };

describe("classifyRecommendationPlatform", () => {
	it("maps each hardware shape to its platform class", () => {
		expect(
			classifyRecommendationPlatform(
				probe({ mobile: { platform: "android" } }),
			),
		).toBe("mobile");
		expect(
			classifyRecommendationPlatform(
				probe({ platform: "darwin", arch: "arm64", appleSilicon: true }),
			),
		).toBe("apple-silicon");
		expect(
			classifyRecommendationPlatform(
				probe({ platform: "linux", gpu: cudaGpu }),
			),
		).toBe("linux-gpu");
		expect(classifyRecommendationPlatform(probe({ platform: "linux" }))).toBe(
			"linux-cpu",
		);
		expect(
			classifyRecommendationPlatform(
				probe({ platform: "win32", gpu: cudaGpu }),
			),
		).toBe("desktop-gpu");
		expect(classifyRecommendationPlatform(probe({ platform: "win32" }))).toBe(
			"desktop-cpu",
		);
	});

	it("treats mobile and apple-silicon as higher precedence than gpu/platform", () => {
		// mobile wins even with a GPU present.
		expect(
			classifyRecommendationPlatform(
				probe({ gpu: cudaGpu, mobile: { platform: "ios" } }),
			),
		).toBe("mobile");
	});
});

describe("deviceCapsFromProbe", () => {
	it("includes cpu for x86 and adds the probed GPU backend, RAM in MB", () => {
		expect(
			deviceCapsFromProbe(probe({ totalRamGb: 8, gpu: metalGpu })),
		).toEqual({
			availableBackends: ["cpu", "metal"],
			ramMb: 8192,
			cpuFeatures: undefined,
		});
	});

	it("requires NEON for an arm CPU backend to count", () => {
		expect(
			deviceCapsFromProbe(probe({ arch: "arm64", cpuFeatures: { neon: true } }))
				.availableBackends,
		).toEqual(["cpu"]);
		expect(
			deviceCapsFromProbe(probe({ arch: "arm64" })).availableBackends,
		).toEqual([]);
		// arm without neon but with a GPU still exposes the GPU backend only.
		expect(
			deviceCapsFromProbe(probe({ arch: "arm64", gpu: metalGpu }))
				.availableBackends,
		).toEqual(["metal"]);
	});
});

describe("catalog download size", () => {
	it("reads sizeGb and converts to bytes", () => {
		const model = { sizeGb: 2 } as CatalogModel;
		expect(catalogDownloadSizeGb(model)).toBe(2);
		expect(catalogDownloadSizeBytes(model)).toBe(2 * 1024 ** 3);
	});
});

describe("selectBestQuantizationVariant", () => {
	const variant = (id: string, status: "published" | "planned") => ({
		id,
		label: "4-bit",
		ggufFile: `${id}.gguf`,
		sizeGb: 1,
		minRamGb: 2,
		status,
	});

	it("prefers the default variant, then published, then first, else null", () => {
		expect(
			selectBestQuantizationVariant({
				quantization: {
					defaultVariantId: "q4",
					variants: [variant("q4", "published"), variant("q8", "published")],
				},
			} as unknown as CatalogModel)?.id,
		).toBe("q4");

		expect(
			selectBestQuantizationVariant({
				quantization: {
					defaultVariantId: "missing",
					variants: [variant("q5", "planned"), variant("q6", "published")],
				},
			} as unknown as CatalogModel)?.id,
		).toBe("q6");

		expect(
			selectBestQuantizationVariant({
				quantization: {
					defaultVariantId: "missing",
					variants: [variant("q3", "planned")],
				},
			} as unknown as CatalogModel)?.id,
		).toBe("q3");

		expect(selectBestQuantizationVariant({} as CatalogModel)).toBeNull();
	});
});
