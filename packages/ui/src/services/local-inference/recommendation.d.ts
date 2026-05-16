import type {
  CatalogModel,
  HardwareFitLevel,
  HardwareProbe,
  TextGenerationSlot,
} from "./types";
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
export declare function classifyRecommendationPlatform(
  hardware: HardwareProbe,
): RecommendationPlatformClass;
export declare function catalogDownloadSizeGb(
  model: CatalogModel,
  catalog?: CatalogModel[],
): number;
export declare function catalogDownloadSizeBytes(
  model: CatalogModel,
  catalog?: CatalogModel[],
): number;
export declare function assessCatalogModelFit(
  hardware: HardwareProbe,
  model: CatalogModel,
  catalog?: CatalogModel[],
): HardwareFitLevel;
export interface RecommendationOptions {
  /**
   * Kernels actually advertised by the installed llama-server binary
   * (parsed from CAPABILITIES.json next to it). When provided, models
   * declaring `requiresKernel` not satisfied by this map are filtered
   * out so we don't recommend a model the user can't actually run on
   * this binary. Pass null/omit when no probe is available — recommender
   * trusts the catalog and the dispatcher's load-time check.
   */
  binaryKernels?: Partial<Record<string, boolean>> | null;
}
export declare function selectRecommendedModelForSlot(
  slot: TextGenerationSlot,
  hardware: HardwareProbe,
  catalog?: CatalogModel[],
  options?: RecommendationOptions,
): RecommendedModelSelection;
export declare function selectRecommendedModels(
  hardware: HardwareProbe,
  catalog?: CatalogModel[],
  options?: RecommendationOptions,
): Record<TextGenerationSlot, RecommendedModelSelection>;
/**
 * Pick the model the engine should auto-load on first run when no user
 * preference exists. Always resolves to an Eliza-1 default-eligible
 * tier — never a non-Eliza catalog entry, never a HF-search result.
 *
 * Resolution order (mirrors `app-core` recommendation.ts):
 *   1. `FIRST_RUN_DEFAULT_MODEL_ID` when present in the catalog, in the
 *      default-eligible set, and not marked `publishStatus: "pending"`.
 *   2. The first default-eligible, non-pending chat entry in the catalog
 *      as a fallback when the preferred id's HF bundle isn't published
 *      yet (elizaOS/eliza#7629).
 *   3. If every default-eligible tier is pending, last-resort to ANY
 *      default-eligible tier so the download path surfaces the 404
 *      cleanly rather than silently picking a non-Eliza model.
 *
 * Returns null only when no default-eligible entry exists at all —
 * which means the catalog is misconfigured and the caller should
 * surface a hard error rather than degrade silently.
 */
export declare function recommendForFirstRun(
  catalog?: CatalogModel[],
): CatalogModel | null;
export declare function chooseSmallerFallbackModel(
  currentModelId: string,
  hardware: HardwareProbe,
  slot?: TextGenerationSlot,
  catalog?: CatalogModel[],
): CatalogModel | null;
//# sourceMappingURL=recommendation.d.ts.map
