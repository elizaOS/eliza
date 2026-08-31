/**
 * Runtime facade for the shared local-model recommendation policy. This host
 * projects validated on-disk manifest budgets into browser-safe policy input
 * and retains only runtime-specific bundle eligibility checks.
 */

import {
	assessCatalogModelFit as assessSharedCatalogModelFit,
	catalogDownloadSizeBytes,
	catalogDownloadSizeGb,
	chooseSmallerFallbackModel as chooseSharedSmallerFallbackModel,
	classifyRecommendationPlatform,
	MODEL_CATALOG,
	type RecommendationPlatformClass,
	type RecommendedModelSelection,
	recommendForFirstRun,
	type RecommendationOptions as SharedRecommendationOptions,
	selectRecommendedModelForSlot as selectSharedRecommendedModelForSlot,
	selectRecommendedModels as selectSharedRecommendedModels,
} from "@elizaos/shared/local-inference";
import {
	canSetAsDefault,
	type Eliza1Backend,
	type Eliza1DeviceCaps,
	type Eliza1Manifest,
	SUPPORTED_BACKENDS_BY_TIER,
} from "./manifest";
import {
	defaultManifestLoader,
	type ManifestLoader,
	resolveRamBudget,
} from "./ram-budget";
import type {
	CatalogModel,
	CatalogQuantizationVariant,
	HardwareFitLevel,
	HardwareProbe,
	InstalledModel,
	TextGenerationSlot,
} from "./types";

export type { RecommendationPlatformClass, RecommendedModelSelection };
export {
	catalogDownloadSizeBytes,
	catalogDownloadSizeGb,
	classifyRecommendationPlatform,
	recommendForFirstRun,
};

export interface RecommendationOptions {
	binaryKernels?: Partial<Record<string, boolean>> | null;
	installed?: ReadonlyArray<InstalledModel>;
	manifestLoader?: ManifestLoader;
}

function sharedOptions(
	catalog: readonly CatalogModel[],
	options: RecommendationOptions,
): SharedRecommendationOptions {
	const installed = options.installed ?? [];
	const manifestLoader = options.manifestLoader ?? defaultManifestLoader;
	const ramBudgets = Object.fromEntries(
		catalog.map((model) => {
			const budget = resolveRamBudget(
				model,
				installed.find((entry) => entry.id === model.id),
				manifestLoader,
			);
			return [
				model.id,
				{ minMb: budget.minMb, recommendedMb: budget.recommendedMb },
			];
		}),
	);
	return { binaryKernels: options.binaryKernels, ramBudgets };
}

export function assessCatalogModelFit(
	hardware: HardwareProbe,
	model: CatalogModel,
	catalog: CatalogModel[] = MODEL_CATALOG,
	options: { installed?: InstalledModel; manifestLoader?: ManifestLoader } = {},
): HardwareFitLevel {
	const runtimeOptions: RecommendationOptions = {
		installed: options.installed ? [options.installed] : [],
		manifestLoader: options.manifestLoader,
	};
	return assessSharedCatalogModelFit(
		hardware,
		model,
		catalog,
		sharedOptions(catalog, runtimeOptions),
	);
}

export function selectRecommendedModelForSlot(
	slot: TextGenerationSlot,
	hardware: HardwareProbe,
	catalog: CatalogModel[] = MODEL_CATALOG,
	options: RecommendationOptions = {},
): RecommendedModelSelection {
	return selectSharedRecommendedModelForSlot(
		slot,
		hardware,
		catalog,
		sharedOptions(catalog, options),
	);
}

export function selectRecommendedModels(
	hardware: HardwareProbe,
	catalog: CatalogModel[] = MODEL_CATALOG,
	options: RecommendationOptions = {},
): Record<TextGenerationSlot, RecommendedModelSelection> {
	return selectSharedRecommendedModels(
		hardware,
		catalog,
		sharedOptions(catalog, options),
	);
}

export function chooseSmallerFallbackModel(
	currentModelId: string,
	hardware: HardwareProbe,
	slot: TextGenerationSlot = "TEXT_LARGE",
	catalog: CatalogModel[] = MODEL_CATALOG,
	options: RecommendationOptions = {},
): CatalogModel | null {
	return chooseSharedSmallerFallbackModel(
		currentModelId,
		hardware,
		slot,
		catalog,
		sharedOptions(catalog, options),
	);
}

export function selectBestQuantizationVariant(
	model: CatalogModel,
): CatalogQuantizationVariant | null {
	const quantization = model.quantization;
	if (!quantization) return null;
	return (
		quantization.variants.find(
			(variant) => variant.id === quantization.defaultVariantId,
		) ??
		quantization.variants.find((variant) => variant.status === "published") ??
		quantization.variants[0] ??
		null
	);
}

export function deviceCapsFromProbe(hardware: HardwareProbe): Eliza1DeviceCaps {
	const backends: Eliza1Backend[] =
		hardware.arch === "arm64" || hardware.arch === "arm"
			? hardware.cpuFeatures?.neon === true
				? ["cpu"]
				: []
			: ["cpu"];
	if (hardware.gpu) backends.push(hardware.gpu.backend);
	return {
		availableBackends: backends,
		ramMb: Math.round(hardware.totalRamGb * 1024),
		cpuFeatures: hardware.cpuFeatures,
	};
}

export type BundleDefaultEligibility =
	| { canBeDefault: true }
	| {
			canBeDefault: false;
			reason:
				| "no-manifest"
				| "not-default-eligible"
				| "ram-below-floor"
				| "kernels-unverified-on-device"
				| "not-verified-on-device";
			detail: string;
	  };

export function canBundleBeDefaultOnDevice(
	installed: InstalledModel,
	hardware: HardwareProbe,
	options: { manifestLoader?: ManifestLoader } = {},
): BundleDefaultEligibility {
	const loader = options.manifestLoader ?? defaultManifestLoader;
	const manifest: Eliza1Manifest | null = loader(installed.id, installed);
	if (!manifest) {
		return {
			canBeDefault: false,
			reason: "no-manifest",
			detail: `${installed.id}: no validated eliza-1.manifest.json next to the bundle`,
		};
	}
	if (!installed.bundleVerifiedAt) {
		return {
			canBeDefault: false,
			reason: "not-verified-on-device",
			detail: `${installed.id}: bundle materialized but the on-device verify pass (load → 1-token text → 1-phrase voice → barge-in) has not run`,
		};
	}
	const caps = deviceCapsFromProbe(hardware);
	if (canSetAsDefault(manifest, caps)) return { canBeDefault: true };
	if (manifest.ramBudgetMb.min > caps.ramMb) {
		return {
			canBeDefault: false,
			reason: "ram-below-floor",
			detail: `${installed.id}: device RAM ${caps.ramMb} MB is below the manifest floor ${manifest.ramBudgetMb.min} MB`,
		};
	}
	const supported = new Set<Eliza1Backend>(
		SUPPORTED_BACKENDS_BY_TIER[manifest.tier],
	);
	const verifiedOnDeviceBackend = caps.availableBackends.some(
		(backend) =>
			supported.has(backend) &&
			manifest.kernels.verifiedBackends[backend].status === "pass",
	);
	if (!verifiedOnDeviceBackend) {
		return {
			canBeDefault: false,
			reason: "kernels-unverified-on-device",
			detail: `${installed.id}: no backend the device exposes (${caps.availableBackends.join(", ")}) has a 'pass' kernel-verify report in the manifest`,
		};
	}
	return {
		canBeDefault: false,
		reason: "not-default-eligible",
		detail: `${installed.id}: manifest failed the contract check (an eval gate, kernel-coverage rule, or lineage/files consistency rule)`,
	};
}
