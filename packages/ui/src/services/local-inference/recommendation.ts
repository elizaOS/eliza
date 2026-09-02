/** Applies the UI product policy to the shared local-model recommendation kernel. */

import {
  assessCatalogModelFit,
  catalogDownloadSizeBytes,
  catalogDownloadSizeGb,
  chooseSmallerFallbackModel as chooseSharedSmallerFallbackModel,
  classifyRecommendationPlatform,
  type RecommendationPlatformClass,
  type RecommendedModelSelection,
  recommendForFirstRun,
  type RecommendationOptions as SharedRecommendationOptions,
  selectRecommendedModelForSlot as selectSharedRecommendedModelForSlot,
  selectRecommendedModels as selectSharedRecommendedModels,
  UI_LOCAL_INFERENCE_RECOMMENDATION_POLICY,
} from "@elizaos/shared/local-inference";
import { MODEL_CATALOG } from "./catalog";
import type { CatalogModel, HardwareProbe, TextGenerationSlot } from "./types";

export type RecommendationOptions = Omit<SharedRecommendationOptions, "policy">;
export type { RecommendationPlatformClass, RecommendedModelSelection };
export {
  assessCatalogModelFit,
  catalogDownloadSizeBytes,
  catalogDownloadSizeGb,
  classifyRecommendationPlatform,
  recommendForFirstRun,
};

function uiOptions(
  options: RecommendationOptions,
): SharedRecommendationOptions {
  return { ...options, policy: UI_LOCAL_INFERENCE_RECOMMENDATION_POLICY };
}

export function selectRecommendedModelForSlot(
  slot: TextGenerationSlot,
  hardware: HardwareProbe,
  catalog: readonly CatalogModel[] = MODEL_CATALOG,
  options: RecommendationOptions = {},
): RecommendedModelSelection {
  return selectSharedRecommendedModelForSlot(
    slot,
    hardware,
    catalog,
    uiOptions(options),
  );
}

export function selectRecommendedModels(
  hardware: HardwareProbe,
  catalog: readonly CatalogModel[] = MODEL_CATALOG,
  options: RecommendationOptions = {},
): Record<TextGenerationSlot, RecommendedModelSelection> {
  return selectSharedRecommendedModels(hardware, catalog, uiOptions(options));
}

export function chooseSmallerFallbackModel(
  currentModelId: string,
  hardware: HardwareProbe,
  slot: TextGenerationSlot = "TEXT_LARGE",
  catalog: readonly CatalogModel[] = MODEL_CATALOG,
  options: RecommendationOptions = {},
): CatalogModel | null {
  return chooseSharedSmallerFallbackModel(
    currentModelId,
    hardware,
    slot,
    catalog,
    uiOptions(options),
  );
}
