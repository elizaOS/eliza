import { MODEL_CATALOG } from "./catalog";
import { assessFit } from "./hardware";
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

const BYTES_PER_GB = 1024 ** 3;

const SLOT_LADDERS: Record<
  RecommendationPlatformClass,
  Record<TextGenerationSlot, string[]>
> = {
  mobile: {
    TEXT_SMALL: [
      "qwen3.5-4b-dflash",
      "llama-3.2-3b",
      "smollm2-1.7b",
      "llama-3.2-1b",
      "smollm2-360m",
    ],
    TEXT_LARGE: [
      "qwen3.5-4b-dflash",
      "llama-3.2-3b",
      "smollm2-1.7b",
      "llama-3.2-1b",
      "smollm2-360m",
    ],
  },
  "apple-silicon": {
    TEXT_SMALL: [
      "qwen3.5-4b-dflash",
      "llama-3.2-3b",
      "smollm2-1.7b",
      "llama-3.2-1b",
    ],
    TEXT_LARGE: [
      "qwen3.6-27b-dflash",
      "qwen3.5-9b-dflash",
      "qwen3.5-4b-dflash",
      "gemma-2-9b",
      "llama-3.1-8b",
      "llama-3.2-3b",
    ],
  },
  "linux-gpu": {
    TEXT_SMALL: [
      "qwen3.5-4b-dflash",
      "llama-3.2-3b",
      "smollm2-1.7b",
      "llama-3.2-1b",
    ],
    TEXT_LARGE: [
      "qwen3.6-27b-dflash",
      "qwen3.5-9b-dflash",
      "qwen3.5-4b-dflash",
      "qwen2.5-coder-14b",
      "gemma-2-9b",
      "llama-3.1-8b",
    ],
  },
  "linux-cpu": {
    TEXT_SMALL: [
      "qwen3.5-4b-dflash",
      "llama-3.2-3b",
      "smollm2-1.7b",
      "llama-3.2-1b",
      "smollm2-360m",
    ],
    TEXT_LARGE: [
      "qwen3.5-9b-dflash",
      "qwen3.5-4b-dflash",
      "llama-3.2-3b",
      "smollm2-1.7b",
      "llama-3.2-1b",
    ],
  },
  "desktop-gpu": {
    TEXT_SMALL: [
      "qwen3.5-4b-dflash",
      "llama-3.2-3b",
      "smollm2-1.7b",
      "llama-3.2-1b",
    ],
    TEXT_LARGE: [
      "qwen3.6-27b-dflash",
      "qwen3.5-9b-dflash",
      "qwen3.5-4b-dflash",
      "qwen2.5-coder-14b",
      "gemma-2-9b",
      "llama-3.1-8b",
    ],
  },
  "desktop-cpu": {
    TEXT_SMALL: [
      "qwen3.5-4b-dflash",
      "llama-3.2-3b",
      "smollm2-1.7b",
      "llama-3.2-1b",
      "smollm2-360m",
    ],
    TEXT_LARGE: [
      "qwen3.5-9b-dflash",
      "qwen3.5-4b-dflash",
      "llama-3.2-3b",
      "smollm2-1.7b",
      "llama-3.2-1b",
    ],
  },
};

function catalogById(catalog: CatalogModel[]): Map<string, CatalogModel> {
  return new Map(catalog.map((model) => [model.id, model]));
}

function chatCandidates(catalog: CatalogModel[]): CatalogModel[] {
  return catalog.filter(
    (model) =>
      !model.hiddenFromCatalog && model.runtimeRole !== "dflash-drafter",
  );
}

export function classifyRecommendationPlatform(
  hardware: HardwareProbe,
): RecommendationPlatformClass {
  const platform = hardware.platform as string;
  if (platform === "android" || platform === "ios") return "mobile";
  if (hardware.appleSilicon) return "apple-silicon";
  if (platform === "linux" && hardware.gpu) return "linux-gpu";
  if (platform === "linux") return "linux-cpu";
  if (hardware.gpu) return "desktop-gpu";
  return "desktop-cpu";
}

export function catalogDownloadSizeGb(
  model: CatalogModel,
  catalog: CatalogModel[] = MODEL_CATALOG,
): number {
  const byId = catalogById(catalog);
  return (model.companionModelIds ?? []).reduce((total, companionId) => {
    const companion = byId.get(companionId);
    return total + (companion?.sizeGb ?? 0);
  }, model.sizeGb);
}

export function catalogDownloadSizeBytes(
  model: CatalogModel,
  catalog: CatalogModel[] = MODEL_CATALOG,
): number {
  return Math.round(catalogDownloadSizeGb(model, catalog) * BYTES_PER_GB);
}

function mobileFit(
  hardware: HardwareProbe,
  model: CatalogModel,
  catalog: CatalogModel[],
): HardwareFitLevel {
  const sizeGb = catalogDownloadSizeGb(model, catalog);
  if (hardware.totalRamGb < model.minRamGb) return "wontfit";
  if (sizeGb > hardware.totalRamGb * 0.8) return "wontfit";
  if (sizeGb > hardware.totalRamGb * 0.65) return "tight";
  return "fits";
}

export function assessCatalogModelFit(
  hardware: HardwareProbe,
  model: CatalogModel,
  catalog: CatalogModel[] = MODEL_CATALOG,
): HardwareFitLevel {
  if (model.runtime?.dflash) {
    const byId = catalogById(catalog);
    if (!byId.has(model.runtime.dflash.drafterModelId)) return "wontfit";
  }
  if (classifyRecommendationPlatform(hardware) === "mobile") {
    return mobileFit(hardware, model, catalog);
  }
  return assessFit(
    hardware,
    catalogDownloadSizeGb(model, catalog),
    model.minRamGb,
  );
}

function canFit(
  hardware: HardwareProbe,
  model: CatalogModel,
  catalog: CatalogModel[],
): boolean {
  return assessCatalogModelFit(hardware, model, catalog) !== "wontfit";
}

function modelsFromLadder(
  ids: string[],
  catalog: CatalogModel[],
): CatalogModel[] {
  const byId = catalogById(catalog);
  return ids.flatMap((id) => {
    const model = byId.get(id);
    return model ? [model] : [];
  });
}

function fallbackCandidates(
  slot: TextGenerationSlot,
  hardware: HardwareProbe,
  catalog: CatalogModel[],
): CatalogModel[] {
  const candidates = chatCandidates(catalog).filter((model) =>
    canFit(hardware, model, catalog),
  );
  return candidates.sort((left, right) => {
    const leftDflash = left.runtime?.dflash ? 1 : 0;
    const rightDflash = right.runtime?.dflash ? 1 : 0;
    if (leftDflash !== rightDflash) return rightDflash - leftDflash;
    const sizeDelta =
      catalogDownloadSizeGb(right, catalog) -
      catalogDownloadSizeGb(left, catalog);
    return slot === "TEXT_LARGE" ? sizeDelta : -sizeDelta;
  });
}

export function selectRecommendedModelForSlot(
  slot: TextGenerationSlot,
  hardware: HardwareProbe,
  catalog: CatalogModel[] = MODEL_CATALOG,
): RecommendedModelSelection {
  const platformClass = classifyRecommendationPlatform(hardware);
  const ladder = modelsFromLadder(SLOT_LADDERS[platformClass][slot], catalog);
  const ladderFits = ladder.filter((model) => canFit(hardware, model, catalog));
  const alternatives =
    ladderFits.length > 0
      ? ladderFits
      : fallbackCandidates(slot, hardware, catalog);
  const model = alternatives[0] ?? null;
  const fit = model ? assessCatalogModelFit(hardware, model, catalog) : null;
  return {
    slot,
    platformClass,
    model,
    fit,
    reason: model
      ? `${platformClass} ${slot} ladder selected ${model.id}`
      : `${platformClass} ${slot} ladder has no fitting catalog model`,
    alternatives,
  };
}

export function selectRecommendedModels(
  hardware: HardwareProbe,
  catalog: CatalogModel[] = MODEL_CATALOG,
): Record<TextGenerationSlot, RecommendedModelSelection> {
  return {
    TEXT_SMALL: selectRecommendedModelForSlot("TEXT_SMALL", hardware, catalog),
    TEXT_LARGE: selectRecommendedModelForSlot("TEXT_LARGE", hardware, catalog),
  };
}

export function chooseSmallerFallbackModel(
  currentModelId: string,
  hardware: HardwareProbe,
  slot: TextGenerationSlot = "TEXT_LARGE",
  catalog: CatalogModel[] = MODEL_CATALOG,
): CatalogModel | null {
  const byId = catalogById(catalog);
  const current = byId.get(currentModelId);
  const currentSize = current
    ? catalogDownloadSizeGb(current, catalog)
    : Number.POSITIVE_INFINITY;
  const platformClass = classifyRecommendationPlatform(hardware);
  const ladderFallback = modelsFromLadder(
    SLOT_LADDERS[platformClass][slot],
    catalog,
  )
    .filter((model) => model.id !== currentModelId)
    .filter((model) => catalogDownloadSizeGb(model, catalog) < currentSize)
    .filter((model) => canFit(hardware, model, catalog))[0];
  if (ladderFallback) return ladderFallback;

  return (
    fallbackCandidates(slot, hardware, catalog)
      .filter((model) => model.id !== currentModelId)
      .filter(
        (model) => catalogDownloadSizeGb(model, catalog) < currentSize,
      )[0] ?? null
  );
}
