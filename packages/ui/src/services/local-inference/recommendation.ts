/** Applies the UI product policy to the shared local-model recommendation kernel. */
import { MODEL_CATALOG } from "@elizaos/plugin-native-inference/model-catalog/catalog";
import { UI_LOCAL_INFERENCE_RECOMMENDATION_POLICY } from "@elizaos/plugin-native-inference/model-catalog/recommendation";
import { assessCatalogModelFit } from "@elizaos/plugin-native-inference/model-catalog/recommendation";
import { catalogDownloadSizeBytes } from "@elizaos/plugin-native-inference/model-catalog/recommendation";
import { catalogDownloadSizeGb } from "@elizaos/plugin-native-inference/model-catalog/recommendation";
import { chooseSmallerFallbackModel as chooseSharedSmallerFallbackModel } from "@elizaos/plugin-native-inference/model-catalog/recommendation";
import { classifyRecommendationPlatform } from "@elizaos/plugin-native-inference/model-catalog/recommendation";
import { recommendForFirstRun } from "@elizaos/plugin-native-inference/model-catalog/recommendation";
import { selectRecommendedModelForSlot as selectSharedRecommendedModelForSlot } from "@elizaos/plugin-native-inference/model-catalog/recommendation";
import { selectRecommendedModels as selectSharedRecommendedModels } from "@elizaos/plugin-native-inference/model-catalog/recommendation";
import { type CatalogModel } from "@elizaos/core/contracts/local-inference";
import { type HardwareProbe } from "@elizaos/core/contracts/local-inference";
import { type RecommendationOptions as SharedRecommendationOptions } from "@elizaos/plugin-native-inference/model-catalog/recommendation";
import { type RecommendationPlatformClass } from "@elizaos/plugin-native-inference/model-catalog/recommendation";
import { type RecommendedModelSelection } from "@elizaos/plugin-native-inference/model-catalog/recommendation";
import { type TextGenerationSlot } from "@elizaos/core/contracts/local-inference";
export type RecommendationOptions = Omit<SharedRecommendationOptions, "policy">;
export type { RecommendationPlatformClass, RecommendedModelSelection };
export { assessCatalogModelFit, catalogDownloadSizeBytes, catalogDownloadSizeGb, classifyRecommendationPlatform, recommendForFirstRun, };
function uiOptions(options: RecommendationOptions): SharedRecommendationOptions {
    return { ...options, policy: UI_LOCAL_INFERENCE_RECOMMENDATION_POLICY };
}
export function selectRecommendedModelForSlot(slot: TextGenerationSlot, hardware: HardwareProbe, catalog: readonly CatalogModel[] = MODEL_CATALOG, options: RecommendationOptions = {}): RecommendedModelSelection {
    return selectSharedRecommendedModelForSlot(slot, hardware, catalog, uiOptions(options));
}
export function selectRecommendedModels(hardware: HardwareProbe, catalog: readonly CatalogModel[] = MODEL_CATALOG, options: RecommendationOptions = {}): Record<TextGenerationSlot, RecommendedModelSelection> {
    return selectSharedRecommendedModels(hardware, catalog, uiOptions(options));
}
export function chooseSmallerFallbackModel(currentModelId: string, hardware: HardwareProbe, slot: TextGenerationSlot = "TEXT_LARGE", catalog: readonly CatalogModel[] = MODEL_CATALOG, options: RecommendationOptions = {}): CatalogModel | null {
    return chooseSharedSmallerFallbackModel(currentModelId, hardware, slot, catalog, uiOptions(options));
}
