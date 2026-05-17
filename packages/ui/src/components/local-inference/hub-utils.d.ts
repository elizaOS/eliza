/**
 * Pure helpers used by the Model Hub UI. Kept separate from components so
 * they can be covered by unit tests without a DOM.
 */
import type {
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
  ModelBucket,
} from "../../api/client-local-inference";
export type FitLevel = "fits" | "tight" | "wontfit";
export declare function displayModelName(model: {
  id: string;
  displayName?: string;
}): string;
export declare function formatBytes(bytes: number): string;
export declare function formatEta(ms: number | null): string;
export declare function progressPercent(job: DownloadJob | undefined): number;
export declare function bucketLabel(bucket: ModelBucket): string;
export declare function fitLabel(fit: FitLevel): string;
export declare function computeFit(
  model: CatalogModel,
  hardware: HardwareProbe,
): FitLevel;
/**
 * Decide whether a catalog model is already installed.
 * External models show up with ids like `external-<origin>-<hash>` so we
 * also tolerate matches by filename basename.
 */
export declare function findInstalled(
  model: CatalogModel,
  installed: InstalledModel[],
): InstalledModel | undefined;
export declare function findDownload(
  modelId: string,
  downloads: DownloadJob[],
): DownloadJob | undefined;
/**
 * Client-side lookup of a catalog entry by id. Accepts the catalog as an
 * argument so the hub UI can mix curated + HF-search results without
 * importing the server-side singleton.
 */
export declare function findCatalogModel(
  id: string,
  catalog: CatalogModel[],
): CatalogModel | undefined;
export declare function groupByBucket(
  models: CatalogModel[],
): Map<ModelBucket, CatalogModel[]>;
//# sourceMappingURL=hub-utils.d.ts.map
