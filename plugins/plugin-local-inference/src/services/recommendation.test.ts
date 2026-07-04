/** Covers recommendation-platform classification, device-caps derivation, and catalog download sizing. Deterministic, synthetic probes. */
import type { CatalogModel, HardwareProbe } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { MODEL_CATALOG } from "./catalog.js";
import {
	assessCatalogModelFit,
	canBundleBeDefaultOnDevice,
	catalogDownloadSizeBytes,
	catalogDownloadSizeGb,
	chooseSmallerFallbackModel,
	classifyRecommendationPlatform,
	deviceCapsFromProbe,
	selectBestQuantizationVariant,
	selectRecommendedModelForSlot,
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

describe("canBundleBeDefaultOnDevice gate (#8848)", () => {
	// Types derived from the function signature so the test needs no extra
	// type imports; the manifest-loader injection keeps it model-independent.
	type Installed = Parameters<typeof canBundleBeDefaultOnDevice>[0];
	type Loader = NonNullable<
		Parameters<typeof canBundleBeDefaultOnDevice>[2]
	>["manifestLoader"];

	it("refuses a bundle with no validated manifest", () => {
		const result = canBundleBeDefaultOnDevice(
			{ id: "test-bundle" } as unknown as Installed,
			probe(),
			{ manifestLoader: (() => null) as Loader },
		);
		expect(result.canBeDefault).toBe(false);
		expect(result.reason).toBe("no-manifest");
	});

	it("refuses a bundle whose on-device verify pass has not run", () => {
		// Manifest present but `bundleVerifiedAt` unset → the verify gate fires
		// before any RAM/kernel check, so the manifest content is irrelevant.
		const result = canBundleBeDefaultOnDevice(
			{ id: "test-bundle" } as unknown as Installed,
			probe(),
			{ manifestLoader: (() => ({})) as Loader },
		);
		expect(result.canBeDefault).toBe(false);
		expect(result.reason).toBe("not-verified-on-device");
	});
});

describe("model-fit + smaller-fallback ladder (#8848)", () => {
	const bySize = [...MODEL_CATALOG].sort(
		(a, b) => catalogDownloadSizeGb(a) - catalogDownloadSizeGb(b),
	);
	const smallest = bySize[0];
	const largest = bySize[bySize.length - 1];
	const tiny = probe({ totalRamGb: 1, freeRamGb: 0.5 });
	const huge = probe({ totalRamGb: 128, freeRamGb: 100 });

	it("won't fit even the smallest catalog model on a 1 GB device, but fits on a big one", () => {
		expect(assessCatalogModelFit(tiny, smallest)).toBe("wontfit");
		expect(assessCatalogModelFit(huge, smallest)).toBe("fits");
	});

	it("has no smaller fallback on a 1 GB device, and a strictly-smaller one on a big device", () => {
		expect(chooseSmallerFallbackModel(largest.id, tiny)).toBeNull();
		const fallback = chooseSmallerFallbackModel(largest.id, huge);
		expect(fallback).not.toBeNull();
		expect(fallback?.id).not.toBe(largest.id);
		expect(catalogDownloadSizeGb(fallback as CatalogModel)).toBeLessThan(
			catalogDownloadSizeGb(largest),
		);
	});

	it("selectRecommendedModelForSlot picks a real, fitting catalog model on a capable host", () => {
		const sel = selectRecommendedModelForSlot("TEXT_LARGE", huge);
		expect(sel.model).not.toBeNull();
		expect(MODEL_CATALOG.some((m) => m.id === sel.model?.id)).toBe(true);
	});
});
