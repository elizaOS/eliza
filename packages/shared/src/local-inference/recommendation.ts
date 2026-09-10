/**
 * Browser-safe local-model recommendation policy shared by setup UI and the
 * runtime host. Callers may supply manifest RAM budgets, but platform
 * classification, slot ladders, eligibility, fit, and ranking live here.
 */

import {
  DEFAULT_ELIGIBLE_MODEL_IDS,
  type Eliza1TierId,
  eliza1TierPublishStatus,
  FIRST_RUN_DEFAULT_MODEL_ID,
  MODEL_CATALOG,
} from "./catalog.js";
import type {
  CatalogModel,
  HardwareFitLevel,
  HardwareProbe,
  TextGenerationSlot,
} from "./types.js";

export type RecommendationPlatformClass =
  | "mobile"
  | "apple-silicon"
  | "linux-gpu"
  | "linux-cpu"
  | "desktop-gpu"
  | "desktop-cpu";

export interface RecommendedModelSelection {
  slot: TextGenerationSlot;
  platformClass: RecommendationPlatformClass;
  model: CatalogModel | null;
  fit: HardwareFitLevel | null;
  reason: string;
  alternatives: CatalogModel[];
}

export interface RecommendationRamBudget {
  minMb: number;
  recommendedMb: number;
}

export type ArmCpuBackendAdmission = "allow-unknown" | "require-neon";

/** Product-owned choices that must not be inferred from generic hardware fit. */
export interface LocalInferenceRecommendationPolicy {
  mobileSlotLadders: Readonly<
    Record<TextGenerationSlot, ReadonlyArray<Eliza1TierId>>
  >;
  armCpuBackendAdmission: ArmCpuBackendAdmission;
}

export interface RecommendationOptions {
  binaryKernels?: Partial<Record<string, boolean>> | null;
  /** Validated manifest budgets projected by a runtime host; no filesystem API is used here. */
  ramBudgets?: Readonly<Record<string, RecommendationRamBudget>>;
  /** Host/product policy for recommendation eligibility, independent of RAM fit. */
  policy?: LocalInferenceRecommendationPolicy;
}

const BYTES_PER_GB = 1024 ** 3;
const MB_PER_GB = 1024;
const LONG_CONTEXT_RAM_BUMP_THRESHOLD_GB = 16;
const LONG_CONTEXT_MIN_LENGTH = 65536;
const TIER_2B: Eliza1TierId = "eliza-1-2b";
const TIER_4B: Eliza1TierId = "eliza-1-4b";
const TIER_9B: Eliza1TierId = "eliza-1-9b";
const TIER_27B: Eliza1TierId = "eliza-1-27b";

export const RUNTIME_LOCAL_INFERENCE_RECOMMENDATION_POLICY: LocalInferenceRecommendationPolicy =
  {
    mobileSlotLadders: {
      TEXT_SMALL: [TIER_2B],
      TEXT_LARGE: [TIER_4B, TIER_2B],
    },
    armCpuBackendAdmission: "require-neon",
  };

export const UI_LOCAL_INFERENCE_RECOMMENDATION_POLICY: LocalInferenceRecommendationPolicy =
  {
    mobileSlotLadders: {
      TEXT_SMALL: [TIER_4B],
      TEXT_LARGE: [TIER_4B],
    },
    armCpuBackendAdmission: "allow-unknown",
  };

const SLOT_LADDERS: Record<
  RecommendationPlatformClass,
  Record<TextGenerationSlot, ReadonlyArray<Eliza1TierId>>
> = {
  mobile: RUNTIME_LOCAL_INFERENCE_RECOMMENDATION_POLICY.mobileSlotLadders,
  "apple-silicon": {
    TEXT_SMALL: [TIER_2B, TIER_4B],
    TEXT_LARGE: [TIER_27B, TIER_9B, TIER_4B, TIER_2B],
  },
  "linux-gpu": {
    TEXT_SMALL: [TIER_2B, TIER_4B],
    TEXT_LARGE: [TIER_27B, TIER_9B, TIER_4B, TIER_2B],
  },
  "linux-cpu": {
    TEXT_SMALL: [TIER_2B, TIER_4B],
    TEXT_LARGE: [TIER_9B, TIER_4B, TIER_2B],
  },
  "desktop-gpu": {
    TEXT_SMALL: [TIER_2B, TIER_4B],
    TEXT_LARGE: [TIER_27B, TIER_9B, TIER_4B, TIER_2B],
  },
  "desktop-cpu": {
    TEXT_SMALL: [TIER_2B, TIER_4B],
    TEXT_LARGE: [TIER_9B, TIER_4B, TIER_2B],
  },
};

export function classifyRecommendationPlatform(
  hardware: HardwareProbe,
): RecommendationPlatformClass {
  const mobilePlatform = hardware.mobile?.platform;
  if (mobilePlatform === "android" || mobilePlatform === "ios") return "mobile";
  if (hardware.appleSilicon) return "apple-silicon";
  if (hardware.platform === "linux" && hardware.gpu) return "linux-gpu";
  if (hardware.platform === "linux") return "linux-cpu";
  if (hardware.gpu) return "desktop-gpu";
  return "desktop-cpu";
}

export function catalogDownloadSizeGb(
  model: CatalogModel,
  _catalog: readonly CatalogModel[] = MODEL_CATALOG,
): number {
  return model.sizeGb;
}

export function catalogDownloadSizeBytes(
  model: CatalogModel,
  _catalog: readonly CatalogModel[] = MODEL_CATALOG,
): number {
  return Math.round(model.sizeGb * BYTES_PER_GB);
}

function effectiveMemoryGb(probe: HardwareProbe): number {
  if (probe.appleSilicon) return probe.totalRamGb;
  if (probe.gpu) return Math.max(probe.gpu.totalVramGb, probe.totalRamGb * 0.5);
  return probe.totalRamGb * 0.5;
}

function hasUsableCpuBackend(
  hardware: HardwareProbe,
  policy: LocalInferenceRecommendationPolicy,
): boolean {
  if (hardware.gpu) return true;
  if (hardware.arch !== "arm64" && hardware.arch !== "arm") return true;
  return policy.armCpuBackendAdmission === "require-neon"
    ? hardware.cpuFeatures?.neon === true
    : hardware.cpuFeatures?.neon !== false;
}

export function assessCatalogModelFit(
  hardware: HardwareProbe,
  model: CatalogModel,
  _catalog: readonly CatalogModel[] = MODEL_CATALOG,
  options: RecommendationOptions = {},
): HardwareFitLevel {
  const mobile = classifyRecommendationPlatform(hardware) === "mobile";
  const memoryGb = mobile ? hardware.totalRamGb : effectiveMemoryGb(hardware);
  const memoryMb = memoryGb * MB_PER_GB;
  const budget = options.ramBudgets?.[model.id];
  const minimumMb = budget?.minMb ?? model.minRamGb * MB_PER_GB;
  const recommendedMb = budget?.recommendedMb ?? minimumMb;
  if (memoryMb < minimumMb) return "wontfit";

  const wontFitRatio = mobile ? 0.8 : 0.9;
  const tightRatio = mobile ? 0.65 : 0.7;
  if (model.sizeGb > memoryGb * wontFitRatio) return "wontfit";
  if (model.sizeGb > memoryGb * tightRatio || memoryMb < recommendedMb) {
    return "tight";
  }
  return "fits";
}

function kernelRequirementsSatisfied(
  model: CatalogModel,
  binaryKernels: Partial<Record<string, boolean>> | null,
): boolean {
  const required = model.runtime?.optimizations?.requiresKernel ?? [];
  if (!binaryKernels) return true;
  if (required.length > 0)
    return required.every((key) => binaryKernels[key] === true);
  const unsupported = model.runtime?.optimizations?.unsupportedKernels ?? [];
  return !unsupported.some((key) => binaryKernels[key] === true);
}

function hasLongContextHeadroom(hardware: HardwareProbe): boolean {
  return (
    (hardware.gpu?.totalVramGb ?? 0) >= LONG_CONTEXT_RAM_BUMP_THRESHOLD_GB ||
    hardware.totalRamGb >= LONG_CONTEXT_RAM_BUMP_THRESHOLD_GB
  );
}

function isLongContextModel(model: CatalogModel): boolean {
  return (model.contextLength ?? 0) >= LONG_CONTEXT_MIN_LENGTH;
}

function rankedCandidates(
  slot: TextGenerationSlot,
  hardware: HardwareProbe,
  catalog: readonly CatalogModel[],
  options: RecommendationOptions,
): CatalogModel[] {
  const platformClass = classifyRecommendationPlatform(hardware);
  const policy =
    options.policy ?? RUNTIME_LOCAL_INFERENCE_RECOMMENDATION_POLICY;
  if (!hasUsableCpuBackend(hardware, policy)) return [];
  const byId = new Map(catalog.map((model) => [model.id, model]));
  const slotLadders =
    platformClass === "mobile"
      ? policy.mobileSlotLadders
      : SLOT_LADDERS[platformClass];
  const ladder = slotLadders[slot].flatMap((id) => {
    const model = byId.get(id);
    return model ? [model] : [];
  });
  const eligible = ladder.filter(
    (model) =>
      assessCatalogModelFit(hardware, model, catalog, options) !== "wontfit" &&
      kernelRequirementsSatisfied(model, options.binaryKernels ?? null),
  );
  if (eligible.length > 0) {
    if (slot !== "TEXT_LARGE" || !hasLongContextHeadroom(hardware))
      return eligible;
    return eligible
      .map((model, index) => ({
        model,
        index,
        long: isLongContextModel(model),
      }))
      .sort((left, right) =>
        left.long === right.long
          ? left.index - right.index
          : right.long
            ? 1
            : -1,
      )
      .map(({ model }) => model);
  }

  const fallback = catalog.filter(
    (model) =>
      !model.hiddenFromCatalog &&
      DEFAULT_ELIGIBLE_MODEL_IDS.has(model.id) &&
      assessCatalogModelFit(hardware, model, catalog, options) !== "wontfit" &&
      kernelRequirementsSatisfied(model, options.binaryKernels ?? null),
  );
  const preferLong = hasLongContextHeadroom(hardware);
  return [...fallback].sort((left, right) => {
    if (preferLong && isLongContextModel(left) !== isLongContextModel(right)) {
      return isLongContextModel(right) ? 1 : -1;
    }
    const delta = right.sizeGb - left.sizeGb;
    return slot === "TEXT_LARGE" ? delta : -delta;
  });
}

export function selectRecommendedModelForSlot(
  slot: TextGenerationSlot,
  hardware: HardwareProbe,
  catalog: readonly CatalogModel[] = MODEL_CATALOG,
  options: RecommendationOptions = {},
): RecommendedModelSelection {
  const platformClass = classifyRecommendationPlatform(hardware);
  const alternatives = rankedCandidates(slot, hardware, catalog, options);
  const model = alternatives[0] ?? null;
  return {
    slot,
    platformClass,
    model,
    fit: model
      ? assessCatalogModelFit(hardware, model, catalog, options)
      : null,
    reason: model
      ? `${platformClass} ${slot} ladder selected ${model.id}`
      : `${platformClass} ${slot} ladder has no fitting catalog model`,
    alternatives,
  };
}

export function selectRecommendedModels(
  hardware: HardwareProbe,
  catalog: readonly CatalogModel[] = MODEL_CATALOG,
  options: RecommendationOptions = {},
): Record<TextGenerationSlot, RecommendedModelSelection> {
  return {
    TEXT_SMALL: selectRecommendedModelForSlot(
      "TEXT_SMALL",
      hardware,
      catalog,
      options,
    ),
    TEXT_LARGE: selectRecommendedModelForSlot(
      "TEXT_LARGE",
      hardware,
      catalog,
      options,
    ),
  };
}

export function recommendForFirstRun(
  catalog: readonly CatalogModel[] = MODEL_CATALOG,
): CatalogModel | null {
  const eligible = (model: CatalogModel): boolean =>
    !model.hiddenFromCatalog && DEFAULT_ELIGIBLE_MODEL_IDS.has(model.id);
  const published = (model: CatalogModel): boolean =>
    eligible(model) &&
    (model.publishStatus ??
      eliza1TierPublishStatus(model.id as Eliza1TierId)) === "published";
  const preferred = catalog.find(
    (model) => model.id === FIRST_RUN_DEFAULT_MODEL_ID,
  );
  return (
    (preferred && published(preferred) ? preferred : null) ??
    catalog.find(published) ??
    (preferred && eligible(preferred) ? preferred : null) ??
    catalog.find(eligible) ??
    null
  );
}

export function chooseSmallerFallbackModel(
  currentModelId: string,
  hardware: HardwareProbe,
  slot: TextGenerationSlot = "TEXT_LARGE",
  catalog: readonly CatalogModel[] = MODEL_CATALOG,
  options: RecommendationOptions = {},
): CatalogModel | null {
  const currentSize =
    catalog.find((model) => model.id === currentModelId)?.sizeGb ??
    Number.POSITIVE_INFINITY;
  return (
    rankedCandidates(slot, hardware, catalog, options).find(
      (model) => model.id !== currentModelId && model.sizeGb < currentSize,
    ) ?? null
  );
}
