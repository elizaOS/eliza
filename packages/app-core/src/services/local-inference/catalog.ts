/**
 * Eliza-curated local model catalog.
 *
 * Eliza-1 is the only default-eligible model line. There is exactly one
 * default per device tier (`0_6b`, `1_7b`, `9b`, `27b`, `27b-256k`). The
 * recommendation engine picks one of these tiers based on hardware. See
 * `/Users/shawwalters/eliza-workspace/milady/eliza/packages/inference/AGENTS.md`
 * §2 for the binding tier matrix.
 *
 * HF-search results from outside `elizalabs/eliza-1-*` MUST never be
 * marked default-eligible (handled by `hf-search.ts`, which produces
 * entries that are absent from `DEFAULT_ELIGIBLE_MODEL_IDS`).
 *
 * When upstream naming conventions drift, update `ggufFile` here — we
 * rely on the exact filename for resolved-URL construction in the
 * downloader.
 */

import { ELIZA_1_TIERS, type Eliza1Tier } from "./manifest";
import type { CatalogModel, LocalRuntimeKernel } from "./types";

/**
 * Eliza-1 tier identifiers, in tier-matrix order. Derived from the
 * manifest module's `ELIZA_1_TIERS` so the bundle tier list and the
 * catalog model-id list never drift.
 */
export type Eliza1TierId = `eliza-1-${Eliza1Tier}`;

export const ELIZA_1_TIER_IDS: ReadonlyArray<Eliza1TierId> = ELIZA_1_TIERS.map(
  (tier) => `eliza-1-${tier}` as Eliza1TierId,
);

/**
 * The model id the engine auto-loads on first run when no preference is
 * set. Resolves to the `1_7b` tier — the smallest Eliza-1 tier
 * that fits the broadest range of hardware (modern phone or laptop).
 * Hosts that can't fit `1_7b` get the `0_6b` fallback via
 * the recommendation ladder.
 */
export const FIRST_RUN_DEFAULT_MODEL_ID: Eliza1TierId =
  "eliza-1-1_7b";

/**
 * The single source of truth for default-eligibility. Only Eliza-1
 * tiers are default-eligible. The recommendation engine MUST refuse to
 * surface anything outside this set as a default; HF-search results
 * MUST never appear here.
 */
export const DEFAULT_ELIGIBLE_MODEL_IDS: ReadonlySet<string> = new Set(
  ELIZA_1_TIER_IDS,
);

export function isDefaultEligibleId(id: string): boolean {
  return DEFAULT_ELIGIBLE_MODEL_IDS.has(id);
}

/** Compatibility export for callers that need the Eliza-1 model id set. */
export const ELIZA_1_PLACEHOLDER_IDS: ReadonlySet<string> = new Set(
  ELIZA_1_TIER_IDS,
);

const BASE_REQUIRED_KERNELS: LocalRuntimeKernel[] = [
  "dflash",
  "turbo3",
  "turbo4",
  "qjl_full",
  "polarquant",
];

function requiredKernelsForContext(
  contextLength: number,
): LocalRuntimeKernel[] {
  return contextLength >= 65536
    ? [...BASE_REQUIRED_KERNELS, "turbo3_tcq"]
    : [...BASE_REQUIRED_KERNELS];
}

function drafterId(id: Eliza1TierId): `${Eliza1TierId}-drafter` {
  return `${id}-drafter`;
}

function runtimeFor(
  id: Eliza1TierId,
  contextLength: number,
): CatalogModel["runtime"] {
  return {
    preferredBackend: "llama-server",
    optimizations: {
      parallel: contextLength >= 131072 ? 8 : 4,
      flashAttention: true,
      mlock: contextLength >= 131072,
      requiresKernel: requiredKernelsForContext(contextLength),
    },
    dflash: {
      drafterModelId: drafterId(id),
      specType: "dflash",
      contextSize: contextLength,
      draftContextSize: Math.min(contextLength, 65536),
      draftMin: 2,
      draftMax: contextLength >= 131072 ? 8 : 6,
      gpuLayers: "auto",
      draftGpuLayers: "auto",
      disableThinking: true,
    },
  };
}

function drafterCompanion(args: {
  id: Eliza1TierId;
  displayName: string;
  ggufFile: string;
  params: CatalogModel["params"];
  sizeGb: number;
  minRamGb: number;
  bucket: CatalogModel["bucket"];
}): CatalogModel {
  return {
    id: drafterId(args.id),
    displayName: `${args.displayName} drafter`,
    hfRepo: `elizalabs/${args.id}`,
    ggufFile: args.ggufFile,
    params: args.params,
    quant: "Eliza-1 drafter companion",
    sizeGb: args.sizeGb,
    minRamGb: args.minRamGb,
    category: "drafter",
    bucket: args.bucket,
    hiddenFromCatalog: true,
    runtimeRole: "dflash-drafter",
    companionForModelId: args.id,
    tokenizerFamily: "eliza1",
    blurb: "Eliza-1 drafter companion for the optimized local runtime.",
  };
}

export const MODEL_CATALOG: CatalogModel[] = [
  // ─── Eliza-1 0.6B (low-RAM phones, CPU fallback) ───────────────────
  {
    id: "eliza-1-0_6b",
    displayName: "Eliza-1 0.6B",
    hfRepo: "elizalabs/eliza-1-0_6b",
    ggufFile: "text/eliza-1-0_6b-32k.gguf",
    bundleManifestFile: "eliza-1.manifest.json",
    params: "1B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 0.5,
    minRamGb: 2,
    category: "chat",
    bucket: "small",
    contextLength: 32768,
    tokenizerFamily: "eliza1",
    companionModelIds: ["eliza-1-0_6b-drafter"],
    runtime: runtimeFor("eliza-1-0_6b", 32768),
    blurb:
      "Eliza-1 0.6B — fits low-RAM phones and CPU-only fallback with the optimized local runtime.",
  },
  drafterCompanion({
    id: "eliza-1-0_6b",
    displayName: "Eliza-1 0.6B",
    ggufFile: "dflash/drafter-0_6b.gguf",
    params: "1B",
    sizeGb: 0.25,
    minRamGb: 2,
    bucket: "small",
  }),

  // ─── Eliza-1 1.7B (modern phones) ──────────────────────────────────
  {
    id: "eliza-1-1_7b",
    displayName: "Eliza-1 1.7B",
    hfRepo: "elizalabs/eliza-1-1_7b",
    ggufFile: "text/eliza-1-1_7b-32k.gguf",
    bundleManifestFile: "eliza-1.manifest.json",
    params: "1.7B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 1.2,
    minRamGb: 4,
    category: "chat",
    bucket: "small",
    contextLength: 32768,
    tokenizerFamily: "eliza1",
    companionModelIds: ["eliza-1-1_7b-drafter"],
    runtime: runtimeFor("eliza-1-1_7b", 32768),
    blurb:
      "Eliza-1 1.7B — modern phone default with text and voice prepared for the optimized local runtime.",
  },
  drafterCompanion({
    id: "eliza-1-1_7b",
    displayName: "Eliza-1 1.7B",
    ggufFile: "dflash/drafter-1_7b.gguf",
    params: "1.7B",
    sizeGb: 0.35,
    minRamGb: 4,
    bucket: "small",
  }),

  // ─── Eliza-1 9B (laptops, 24GB phones, 48GB Mac) ───────────────────
  {
    id: "eliza-1-9b",
    displayName: "Eliza-1 9B",
    hfRepo: "elizalabs/eliza-1-9b",
    ggufFile: "text/eliza-1-9b-64k.gguf",
    bundleManifestFile: "eliza-1.manifest.json",
    params: "9B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 5.4,
    minRamGb: 12,
    category: "chat",
    bucket: "mid",
    contextLength: 65536,
    tokenizerFamily: "eliza1",
    companionModelIds: ["eliza-1-9b-drafter"],
    runtime: runtimeFor("eliza-1-9b", 65536),
    blurb:
      "Eliza-1 9B — laptop / 24 GB phone / 48 GB Mac default with text, voice, and vision in the optimized local runtime.",
  },
  drafterCompanion({
    id: "eliza-1-9b",
    displayName: "Eliza-1 9B",
    ggufFile: "dflash/drafter-9b.gguf",
    params: "9B",
    sizeGb: 0.8,
    minRamGb: 12,
    bucket: "mid",
  }),

  // ─── Eliza-1 27B (96GB+ Mac, high-VRAM desktop) ────────────────────
  {
    id: "eliza-1-27b",
    displayName: "Eliza-1 27B",
    hfRepo: "elizalabs/eliza-1-27b",
    ggufFile: "text/eliza-1-27b-128k.gguf",
    bundleManifestFile: "eliza-1.manifest.json",
    params: "27B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 16.8,
    minRamGb: 32,
    category: "chat",
    bucket: "large",
    contextLength: 131072,
    tokenizerFamily: "eliza1",
    companionModelIds: ["eliza-1-27b-drafter"],
    runtime: runtimeFor("eliza-1-27b", 131072),
    blurb:
      "Eliza-1 27B — 96 GB+ Mac and high-VRAM desktop default. Fused text + voice + vision; 128k context on workstation hardware.",
  },
  drafterCompanion({
    id: "eliza-1-27b",
    displayName: "Eliza-1 27B",
    ggufFile: "dflash/drafter-27b.gguf",
    params: "9B",
    sizeGb: 1.2,
    minRamGb: 32,
    bucket: "large",
  }),

  // ─── Eliza-1 27B 256k (workstation / server) ───────────────────────
  {
    id: "eliza-1-27b-256k",
    displayName: "Eliza-1 27B 256k",
    hfRepo: "elizalabs/eliza-1-27b-256k",
    ggufFile: "text/eliza-1-27b-256k-256k.gguf",
    bundleManifestFile: "eliza-1.manifest.json",
    params: "27B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 16.8,
    minRamGb: 96,
    category: "chat",
    bucket: "large",
    contextLength: 262144,
    tokenizerFamily: "eliza1",
    companionModelIds: ["eliza-1-27b-256k-drafter"],
    runtime: runtimeFor("eliza-1-27b-256k", 262144),
    blurb:
      "Eliza-1 27B 256k — H200-class workstation tier with the largest context window in the line.",
  },
  drafterCompanion({
    id: "eliza-1-27b-256k",
    displayName: "Eliza-1 27B 256k",
    ggufFile: "dflash/drafter-27b-256k.gguf",
    params: "9B",
    sizeGb: 1.2,
    minRamGb: 96,
    bucket: "large",
  }),
];

export function findCatalogModel(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/**
 * Construct the HuggingFace resolve URL for a given catalog entry.
 *
 * Respects `ELIZA_HF_BASE_URL` when set so self-hosted HF mirrors and the
 * downloader e2e test suite can redirect all downloads without touching
 * the catalog.
 */
export function buildHuggingFaceResolveUrlForPath(
  model: CatalogModel,
  filePath: string,
): string {
  const base =
    process.env.ELIZA_HF_BASE_URL?.trim().replace(/\/+$/, "") ||
    "https://huggingface.co";
  // Encode each path segment separately so nested bundle layouts like
  // `text/eliza-1-1_7b-32k.gguf` keep their slashes.
  const encodedPath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/${model.hfRepo}/resolve/main/${encodedPath}?download=true`;
}

export function buildHuggingFaceResolveUrl(model: CatalogModel): string {
  return buildHuggingFaceResolveUrlForPath(model, model.ggufFile);
}
