/**
 * Policy predicates over the model catalog: which models are the default Eliza-1
 * family and thus eligible for the first-run local path.
 */
import { DEFAULT_ELIGIBLE_MODEL_IDS } from "./catalog";
import type { CatalogModel, InstalledModel } from "./types";

export function isEliza1ModelFamilyId(id: string): boolean {
  return id.startsWith("eliza-1-");
}

export function isDefaultLocalModelFamily(model: CatalogModel): boolean {
  return (
    isEliza1ModelFamilyId(model.id) && DEFAULT_ELIGIBLE_MODEL_IDS.has(model.id)
  );
}

export function isSettingsDefaultLocalModel(model: CatalogModel): boolean {
  return !model.hiddenFromCatalog && isDefaultLocalModelFamily(model);
}

export function isVerifiedCuratedEliza1Download(
  model: InstalledModel,
): boolean {
  return (
    model.source === "eliza-download" &&
    DEFAULT_ELIGIBLE_MODEL_IDS.has(model.id) &&
    typeof model.bundleVerifiedAt === "string" &&
    model.bundleVerifiedAt.length > 0
  );
}

export function filterSettingsDefaultLocalModels(
  catalog: CatalogModel[],
): CatalogModel[] {
  return catalog.filter(isSettingsDefaultLocalModel);
}
