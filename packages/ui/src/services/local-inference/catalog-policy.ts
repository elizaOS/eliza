import { DEFAULT_ELIGIBLE_MODEL_IDS } from "./catalog";
import type { CatalogModel } from "./types";

export function isEliza1ModelFamilyId(id: string): boolean {
  return id.startsWith("eliza-1-");
}

export function isDefaultLocalModelFamily(model: CatalogModel): boolean {
  return (
    isEliza1ModelFamilyId(model.id) && DEFAULT_ELIGIBLE_MODEL_IDS.has(model.id)
  );
}

export function isSettingsDefaultLocalModel(model: CatalogModel): boolean {
  return (
    !model.hiddenFromCatalog &&
    model.runtimeRole !== "dflash-drafter" &&
    isDefaultLocalModelFamily(model)
  );
}

export function filterSettingsDefaultLocalModels(
  catalog: CatalogModel[],
): CatalogModel[] {
  return catalog.filter(isSettingsDefaultLocalModel);
}
