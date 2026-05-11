import {
  DEFAULT_ELIGIBLE_MODEL_IDS,
  type Eliza1TierId,
  FIRST_RUN_DEFAULT_MODEL_ID,
  MODEL_CATALOG,
} from "./catalog";
import { assessFit } from "./hardware";
import {
  type ManifestLoader,
  type RamBudget,
  defaultManifestLoader,
  resolveRamBudget,
} from "./ram-budget";
import type {
  CatalogModel,
  HardwareFitLevel,
  HardwareProbe,
  InstalledModel,
  TextGenerationSlot,
} from "./types";

// Local tier-id constants derived once from the manifest-driven catalog
// type so the ladder definitions can't drift from the canonical list.
// Adding a tier requires extending the manifest module; this file picks
// it up automatically.
const TIER_LITE: Eliza1TierId = "eliza-1-0_6b";
const TIER_MOBILE: Eliza1TierId = "eliza-1-1_7b";
const TIER_DESKTOP: Eliza1TierId = "eliza-1-9b";
const TIER_PRO: Eliza1TierId = "eliza-1-27b";
const TIER_SERVER: Eliza1TierId = "eliza-1-27b-256k";

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

/**
 * Per-platform slot ladders. Every default-recommended entry is an
 * Eliza-1 tier (the only default-eligible line — see catalog.ts and
 * `packages/inference/AGENTS.md` §2). Ladders bias toward the smallest
 * tier that fits the platform; desktops/servers pick larger tiers
 * first when memory headroom allows.
 */
const SLOT_LADDERS: Record<
  RecommendationPlatformClass,
  Record<TextGenerationSlot, ReadonlyArray<Eliza1TierId>>
> = {
  mobile: {
    TEXT_SMALL: [TIER_LITE, TIER_MOBILE],
    TEXT_LARGE: [TIER_MOBILE, TIER_LITE],
  },
  "apple-silicon": {
    TEXT_SMALL: [TIER_MOBILE, TIER_LITE],
    TEXT_LARGE: [TIER_PRO, TIER_DESKTOP, TIER_MOBILE],
  },
  "linux-gpu": {
    TEXT_SMALL: [TIER_MOBILE, TIER_LITE],
    TEXT_LARGE: [TIER_SERVER, TIER_PRO, TIER_DESKTOP, TIER_MOBILE],
  },
  "linux-cpu": {
    TEXT_SMALL: [TIER_MOBILE, TIER_LITE],
    TEXT_LARGE: [TIER_DESKTOP, TIER_MOBILE],
  },
  "desktop-gpu": {
    TEXT_SMALL: [TIER_MOBILE, TIER_LITE],
    TEXT_LARGE: [TIER_SERVER, TIER_PRO, TIER_DESKTOP, TIER_MOBILE],
  },
  "desktop-cpu": {
    TEXT_SMALL: [TIER_MOBILE, TIER_LITE],
    TEXT_LARGE: [TIER_DESKTOP, TIER_MOBILE],
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
  // Mobile detection comes from the typed `hardware.mobile.platform`
  // field (`"ios" | "android" | "web"`). `NodeJS.Platform` doesn't
  // include those values — the previous `process.platform as string`
  // cast was hiding that the cast was the only way the comparison
  // type-checked. Reading the proper typed field is both safer and
  // accurate when a host advertises mobile via the mobile probe.
  const mobilePlatform = hardware.mobile?.platform;
  if (mobilePlatform === "android" || mobilePlatform === "ios") return "mobile";

  const platform = hardware.platform;
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

const MB_PER_GB = 1024;

function mobileFit(
  hardware: HardwareProbe,
  model: CatalogModel,
  catalog: CatalogModel[],
  budget: RamBudget,
): HardwareFitLevel {
  const sizeGb = catalogDownloadSizeGb(model, catalog);
  const totalRamMb = hardware.totalRamGb * MB_PER_GB;
  // `minMb` is the won't-fit floor (catalog scalar by default; manifest
  // override when an installed Eliza-1 bundle declared one).
  if (totalRamMb < budget.minMb) return "wontfit";
  if (sizeGb > hardware.totalRamGb * 0.8) return "wontfit";
  // `recommendedMb` is the fits-vs-tight cutoff. Catalog fallback collapses
  // recommended === min so the new line never tightens prior behavior.
  if (totalRamMb < budget.recommendedMb) return "tight";
  if (sizeGb > hardware.totalRamGb * 0.65) return "tight";
  return "fits";
}

export function assessCatalogModelFit(
  hardware: HardwareProbe,
  model: CatalogModel,
  catalog: CatalogModel[] = MODEL_CATALOG,
  options: { installed?: InstalledModel; manifestLoader?: ManifestLoader } = {},
): HardwareFitLevel {
  if (model.runtime?.dflash) {
    const byId = catalogById(catalog);
    if (!byId.has(model.runtime.dflash.drafterModelId)) return "wontfit";
  }
  const budget = resolveRamBudget(
    model,
    options.installed,
    options.manifestLoader ?? defaultManifestLoader,
  );
  if (classifyRecommendationPlatform(hardware) === "mobile") {
    return mobileFit(hardware, model, catalog, budget);
  }
  // `assessFit` historically takes minRamGb. Use the manifest-derived
  // floor (minMb) when available; fall back to the catalog scalar
  // otherwise. The manifest's `recommendedMb` further tightens the
  // "fits" line via the wrapper below.
  const baseline = assessFit(
    hardware,
    catalogDownloadSizeGb(model, catalog),
    budget.minMb / MB_PER_GB,
  );
  if (baseline === "wontfit") return "wontfit";
  if (budget.source === "manifest") {
    const effectiveGb = effectiveMemoryGb(hardware);
    if (effectiveGb * MB_PER_GB < budget.recommendedMb) return "tight";
  }
  return baseline;
}

/** Mirrors the effective-memory math in `assessFit`. */
function effectiveMemoryGb(probe: HardwareProbe): number {
  if (probe.appleSilicon) return probe.totalRamGb;
  if (probe.gpu) {
    return Math.max(probe.gpu.totalVramGb, probe.totalRamGb * 0.5);
  }
  return probe.totalRamGb * 0.5;
}

function canFit(
  hardware: HardwareProbe,
  model: CatalogModel,
  catalog: CatalogModel[],
  options: { installed?: InstalledModel; manifestLoader?: ManifestLoader } = {},
): boolean {
  return assessCatalogModelFit(hardware, model, catalog, options) !== "wontfit";
}

/**
 * True when every kernel listed in `model.runtime.optimizations.requiresKernel`
 * is advertised as `true` in the binary's CAPABILITIES.json kernels map.
 *
 * `binaryKernels === null` means we have no probe (older binary, or
 * llama-server isn't installed). In that case we trust the catalog —
 * filtering would hide every kernel-required model and the dispatcher's
 * load-time check will surface the real error if/when the user tries to
 * activate it.
 */
function kernelRequirementsSatisfied(
  model: CatalogModel,
  binaryKernels: Partial<Record<string, boolean>> | null,
): boolean {
  const required = model.runtime?.optimizations?.requiresKernel ?? [];
  if (required.length === 0) return true;
  if (!binaryKernels) return true;
  return required.every((k) => binaryKernels[k] === true);
}

function modelsFromLadder(
  ids: ReadonlyArray<string>,
  catalog: CatalogModel[],
): CatalogModel[] {
  const byId = catalogById(catalog);
  return ids.flatMap((id) => {
    const model = byId.get(id);
    return model ? [model] : [];
  });
}

/**
 * True when this host has enough memory headroom to serve the long-context
 * KV cache for a 64k+ window. Threshold mirrors the "16 GB workstation"
 * line from the porting plan — a 64k context for an 8B model at fp16 KV
 * occupies ~4 GB; with TurboQuant compression it fits inside 1 GB. Below
 * 16 GB total we keep the historical short-context preference.
 *
 * For GPU hosts we look at total VRAM, since the KV cache lives wherever
 * the layers do; for CPU-only hosts we look at total RAM.
 */
const LONG_CONTEXT_RAM_BUMP_THRESHOLD_GB = 16;
const LONG_CONTEXT_MIN_LENGTH = 65536;

function hasLongContextHeadroom(hardware: HardwareProbe): boolean {
  const vramGb = hardware.gpu?.totalVramGb ?? 0;
  if (vramGb >= LONG_CONTEXT_RAM_BUMP_THRESHOLD_GB) return true;
  return hardware.totalRamGb >= LONG_CONTEXT_RAM_BUMP_THRESHOLD_GB;
}

function isLongContextModel(model: CatalogModel): boolean {
  return (
    typeof model.contextLength === "number" &&
    model.contextLength >= LONG_CONTEXT_MIN_LENGTH
  );
}

function fallbackCandidates(
  slot: TextGenerationSlot,
  hardware: HardwareProbe,
  catalog: CatalogModel[],
  budgetOptions: BudgetOptions,
): CatalogModel[] {
  const candidates = chatCandidates(catalog).filter(
    (model) =>
      DEFAULT_ELIGIBLE_MODEL_IDS.has(model.id) &&
      canFit(hardware, model, catalog, budgetOptionsForModel(model, budgetOptions)),
  );
  const preferLongContext = hasLongContextHeadroom(hardware);
  return candidates.sort((left, right) => {
    if (preferLongContext) {
      const leftLong = isLongContextModel(left) ? 1 : 0;
      const rightLong = isLongContextModel(right) ? 1 : 0;
      if (leftLong !== rightLong) return rightLong - leftLong;
    }
    const sizeDelta =
      catalogDownloadSizeGb(right, catalog) -
      catalogDownloadSizeGb(left, catalog);
    return slot === "TEXT_LARGE" ? sizeDelta : -sizeDelta;
  });
}

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
  /**
   * Models the user has already installed. When an Eliza-1 tier in this
   * list has a published `eliza-1.manifest.json` next to its bundle,
   * the recommender consults `manifest.ramBudgetMb` instead of the
   * catalog's coarse `minRamGb` scalar. See `./ram-budget.ts`.
   */
  installed?: ReadonlyArray<InstalledModel>;
  /**
   * Test-only override for the manifest reader. Production callers leave
   * this unset and the helper reads `eliza-1.manifest.json` from disk.
   */
  manifestLoader?: ManifestLoader;
}

interface BudgetOptions {
  installed: ReadonlyArray<InstalledModel>;
  manifestLoader: ManifestLoader;
}

function budgetOptionsForModel(
  model: CatalogModel,
  budget: BudgetOptions,
): { installed?: InstalledModel; manifestLoader: ManifestLoader } {
  return {
    installed: budget.installed.find((m) => m.id === model.id),
    manifestLoader: budget.manifestLoader,
  };
}

function resolveBudgetOptions(options: RecommendationOptions): BudgetOptions {
  return {
    installed: options.installed ?? [],
    manifestLoader: options.manifestLoader ?? defaultManifestLoader,
  };
}

export function selectRecommendedModelForSlot(
  slot: TextGenerationSlot,
  hardware: HardwareProbe,
  catalog: CatalogModel[] = MODEL_CATALOG,
  options: RecommendationOptions = {},
): RecommendedModelSelection {
  const platformClass = classifyRecommendationPlatform(hardware);
  const ladder = modelsFromLadder(SLOT_LADDERS[platformClass][slot], catalog);
  const binaryKernels = options.binaryKernels ?? null;
  const budget = resolveBudgetOptions(options);
  const eligible = ladder.filter(
    (model) =>
      canFit(hardware, model, catalog, budgetOptionsForModel(model, budget)) &&
      kernelRequirementsSatisfied(model, binaryKernels),
  );

  // On hosts with >= 16 GB RAM/VRAM, give long-context (>= 64k) ladder
  // entries a small bump so we surface 128k models when they fit. The
  // ladder order still wins when long-context availability is the same
  // for every entry (or when the host doesn't have the headroom).
  const ranked =
    eligible.length > 0 && hasLongContextHeadroom(hardware)
      ? rankLadderByLongContext(eligible)
      : eligible;

  const alternatives =
    ranked.length > 0
      ? ranked
      : fallbackCandidates(slot, hardware, catalog, budget).filter((model) =>
          kernelRequirementsSatisfied(model, binaryKernels),
        );
  const model = alternatives[0] ?? null;
  const fit = model
    ? assessCatalogModelFit(
        hardware,
        model,
        catalog,
        budgetOptionsForModel(model, budget),
      )
    : null;
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

/**
 * Stable sort that pulls long-context models toward the front while
 * preserving relative order within each group. Used only on hosts with
 * the long-context RAM/VRAM headroom — the ladder order remains the
 * tie-breaker so DFlash-first preferences survive.
 */
function rankLadderByLongContext(ladder: CatalogModel[]): CatalogModel[] {
  return ladder
    .map((model, idx) => ({ model, idx, long: isLongContextModel(model) }))
    .sort((left, right) => {
      if (left.long !== right.long) return right.long ? 1 : -1;
      return left.idx - right.idx;
    })
    .map((entry) => entry.model);
}

export function selectRecommendedModels(
  hardware: HardwareProbe,
  catalog: CatalogModel[] = MODEL_CATALOG,
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

/**
 * Pick the model the engine should auto-load on first run when no user
 * preference exists. Always resolves to an Eliza-1 default-eligible
 * tier — never a non-Eliza catalog entry, never a HF-search result.
 *
 * Resolution order:
 *   1. `FIRST_RUN_DEFAULT_MODEL_ID` when present in the catalog and in
 *      the default-eligible set.
 *   2. The first default-eligible chat entry in the catalog as a
 *      defensive fallback if the default id is somehow missing
 *      (catalog lint should prevent this; see catalog.test.ts).
 *
 * Returns null only when no default-eligible entry exists at all —
 * which means the catalog is misconfigured and the caller should
 * surface a hard error rather than degrade silently.
 */
export function recommendForFirstRun(
  catalog: CatalogModel[] = MODEL_CATALOG,
): CatalogModel | null {
  const byId = catalogById(catalog);
  const preferred = byId.get(FIRST_RUN_DEFAULT_MODEL_ID);
  if (preferred && DEFAULT_ELIGIBLE_MODEL_IDS.has(preferred.id))
    return preferred;
  return (
    catalog.find(
      (model) =>
        !model.hiddenFromCatalog &&
        model.runtimeRole !== "dflash-drafter" &&
        DEFAULT_ELIGIBLE_MODEL_IDS.has(model.id),
    ) ?? null
  );
}

export function chooseSmallerFallbackModel(
  currentModelId: string,
  hardware: HardwareProbe,
  slot: TextGenerationSlot = "TEXT_LARGE",
  catalog: CatalogModel[] = MODEL_CATALOG,
  options: RecommendationOptions = {},
): CatalogModel | null {
  const byId = catalogById(catalog);
  const current = byId.get(currentModelId);
  const currentSize = current
    ? catalogDownloadSizeGb(current, catalog)
    : Number.POSITIVE_INFINITY;
  const platformClass = classifyRecommendationPlatform(hardware);
  const budget = resolveBudgetOptions(options);
  const ladderFallback = modelsFromLadder(
    SLOT_LADDERS[platformClass][slot],
    catalog,
  )
    .filter((model) => model.id !== currentModelId)
    .filter((model) => catalogDownloadSizeGb(model, catalog) < currentSize)
    .filter((model) =>
      canFit(hardware, model, catalog, budgetOptionsForModel(model, budget)),
    )[0];
  if (ladderFallback) return ladderFallback;

  return (
    fallbackCandidates(slot, hardware, catalog, budget)
      .filter((model) => model.id !== currentModelId)
      .filter(
        (model) => catalogDownloadSizeGb(model, catalog) < currentSize,
      )[0] ?? null
  );
}
