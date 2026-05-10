/**
 * Eliza-curated local model catalog.
 *
 * Eliza-1 is the only default-eligible model line. There is exactly one
 * default per device tier (`lite-0_6b`, `mobile-1_7b`, `desktop-9b`,
 * `pro-27b`, `server-h200`). The recommendation engine picks one of
 * these tiers based on hardware. See
 * `/Users/shawwalters/eliza-workspace/milady/packages/inference/AGENTS.md`
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
import type { CatalogModel } from "./types";

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
 * set. Resolves to the `mobile-1_7b` tier — the smallest Eliza-1 tier
 * that fits the broadest range of hardware (modern phone or laptop).
 * Hosts that can't fit `mobile-1_7b` get the `lite-0_6b` fallback via
 * the recommendation ladder.
 */
export const FIRST_RUN_DEFAULT_MODEL_ID: Eliza1TierId = "eliza-1-mobile-1_7b";

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

export const MODEL_CATALOG: CatalogModel[] = [
  // ─── Eliza-1 lite (low-RAM phones, CPU fallback) ────────────────────
  {
    id: "eliza-1-lite-0_6b",
    displayName: "Eliza-1 lite",
    hfRepo: "elizalabs/eliza-1-lite-0_6b",
    ggufFile: "text/eliza-1-lite-0_6b-32k.gguf",
    params: "1B",
    quant: "TurboQuant Q3 + Polar Q4 KV",
    sizeGb: 0.5,
    minRamGb: 2,
    category: "chat",
    bucket: "small",
    contextLength: 32768,
    tokenizerFamily: "eliza1",
    blurb:
      "Eliza-1 lite — fits low-RAM phones and CPU-only fallback. Fused text + voice bundle with TurboQuant Q3 + Polar KV.",
  },

  // ─── Eliza-1 mobile (modern phones) ─────────────────────────────────
  {
    id: "eliza-1-mobile-1_7b",
    displayName: "Eliza-1 mobile",
    hfRepo: "elizalabs/eliza-1-mobile-1_7b",
    ggufFile: "text/eliza-1-mobile-1_7b-32k.gguf",
    params: "1.7B",
    quant: "TurboQuant Q3/Q4 + QJL K-cache",
    sizeGb: 1.2,
    minRamGb: 4,
    category: "chat",
    bucket: "small",
    contextLength: 32768,
    tokenizerFamily: "eliza1",
    blurb:
      "Eliza-1 mobile — modern phone default. Fused text + voice with TurboQuant Q3/Q4 and QJL K-cache.",
  },

  // ─── Eliza-1 desktop (laptops, 24GB phones, 48GB Mac) ───────────────
  {
    id: "eliza-1-desktop-9b",
    displayName: "Eliza-1 desktop",
    hfRepo: "elizalabs/eliza-1-desktop-9b",
    ggufFile: "text/eliza-1-desktop-9b-64k.gguf",
    params: "9B",
    quant: "TurboQuant Q4 + QJL + Polar",
    sizeGb: 5.4,
    minRamGb: 12,
    category: "chat",
    bucket: "mid",
    contextLength: 65536,
    tokenizerFamily: "eliza1",
    blurb:
      "Eliza-1 desktop — laptop / 24 GB phone / 48 GB Mac default. Fused text + voice + vision with TurboQuant Q4, QJL, PolarQuant.",
  },

  // ─── Eliza-1 pro (96GB+ Mac, high-VRAM desktop) ─────────────────────
  {
    id: "eliza-1-pro-27b",
    displayName: "Eliza-1 pro",
    hfRepo: "elizalabs/eliza-1-pro-27b",
    ggufFile: "text/eliza-1-pro-27b-128k.gguf",
    params: "27B",
    quant: "TurboQuant Q4 + QJL + Polar",
    sizeGb: 16.8,
    minRamGb: 32,
    category: "chat",
    bucket: "large",
    contextLength: 131072,
    tokenizerFamily: "eliza1",
    blurb:
      "Eliza-1 pro — 96 GB+ Mac and high-VRAM desktop default. Fused text + voice + vision; longest-context Eliza-1 tier on workstation hardware.",
  },

  // ─── Eliza-1 server (workstation / server) ──────────────────────────
  {
    id: "eliza-1-server-h200",
    displayName: "Eliza-1 server",
    hfRepo: "elizalabs/eliza-1-server-h200",
    ggufFile: "text/eliza-1-server-h200-256k.gguf",
    params: "27B",
    quant: "CUDA TurboQuant + QJL + Polar",
    sizeGb: 16.8,
    minRamGb: 96,
    category: "chat",
    bucket: "large",
    contextLength: 262144,
    tokenizerFamily: "eliza1",
    blurb:
      "Eliza-1 server — H200-class workstation / server. CUDA TurboQuant + QJL + Polar with the largest context window in the line.",
  },

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
export function buildHuggingFaceResolveUrl(model: CatalogModel): string {
  const base =
    process.env.ELIZA_HF_BASE_URL?.trim().replace(/\/+$/, "") ||
    "https://huggingface.co";
  // Encode each path segment separately so nested bundle layouts like
  // `text/eliza-1-mobile-1_7b-32k.gguf` keep their slashes.
  const encodedPath = model.ggufFile
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/${model.hfRepo}/resolve/main/${encodedPath}?download=true`;
}
