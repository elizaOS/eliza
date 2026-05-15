// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * usbeliza local-inference model catalog.
 *
 * The Linux agent offers only the active Eliza-1 release line by default.
 * Every installable runtime artifact resolves from the single
 * `elizaos/eliza-1` Hugging Face repo under `bundles/<tier>/`.
 *
 * Tier scoring is "minRamGb + 4 GB headroom" — the model picker hides any
 * tier whose minRamGb + 4 would exceed `/proc/meminfo` MemTotal at boot,
 * so users never see a tier they cannot fit.
 */

export type ModelTierId =
  | "eliza-1-0_8b"
  | "eliza-1-2b"
  | "eliza-1-4b"
  | "eliza-1-9b"
  | "eliza-1-27b"
  | "eliza-1-2b-drafter"
  | "eliza-1-4b-drafter"
  | "eliza-1-9b-drafter"
  | "eliza-1-27b-drafter";

export type ModelCategory = "chat" | "drafter" | "embedding";
export type ModelBucket = "small" | "mid" | "large";

export interface CatalogModel {
  /** Stable identifier used in calibration.toml and the runtime store. */
  readonly id: ModelTierId | "eliza-1-embedding";
  /** Human-readable label for the picker. */
  readonly displayName: string;
  /** HuggingFace `<owner>/<repo>`. Active defaults must use `elizaos/eliza-1`. */
  readonly hfRepo: string;
  /** Exact GGUF filename inside the repo. We construct the resolve URL from this. */
  readonly ggufFile: string;
  /** Approximate parameter count, for the picker UX. */
  readonly params: string;
  /** Approximate Q4_K_M GGUF size in GB (used to estimate disk + download time). */
  readonly sizeGb: number;
  /** Minimum host RAM the picker requires to surface this tier. */
  readonly minRamGb: number;
  /** Architectural role. */
  readonly category: ModelCategory;
  /** Coarse size bucket — drives UX grouping in the picker. */
  readonly bucket: ModelBucket;
  /** Tokenizer family — DFlash drafter+target MUST share family. */
  readonly tokenizerFamily: "qwen35" | "bert";
  /** Picker copy. One sentence, present-tense. */
  readonly blurb: string;
  /**
   * DFlash drafter pairing. Only set on tiers that have a verified-
   * compatible drafter in this catalog. The drafter's tokenizer family
   * MUST match this tier's.
   */
  readonly dflashDrafter?: ModelTierId;
}

/**
 * The single canonical first-boot baseline. Sized to fit low-memory hosts
 * while staying on the Eliza-1 model line.
 */
export const BASELINE_MODEL_ID: ModelTierId = "eliza-1-0_8b";

/**
 * The default embedding model. Tiny and always bundled.
 */
export const BASELINE_EMBEDDING_ID = "eliza-1-embedding" as const;

const ELIZA_1_REPO = "elizalabs/eliza-1";

export const MODEL_CATALOG: readonly CatalogModel[] = [
  // ─── Always-on embeddings ────────────────────────────────────────
  {
    id: "eliza-1-embedding",
    displayName: "eliza-1 embeddings",
    hfRepo: ELIZA_1_REPO,
    ggufFile: "bundles/2b/embedding/eliza-1-embedding.gguf",
    params: "0.6B",
    sizeGb: 0.4,
    minRamGb: 2,
    category: "embedding",
    bucket: "small",
    tokenizerFamily: "qwen35",
    blurb:
      "Eliza-1 sentence embeddings for retrieval, recall, and search inside generated apps.",
  },

  // ─── Active Eliza-1 chat tiers ───────────────────────────────────
  {
    id: "eliza-1-0_8b",
    displayName: "eliza-1-0_8b",
    hfRepo: ELIZA_1_REPO,
    ggufFile: "bundles/0_8b/text/eliza-1-0_8b-32k.gguf",
    params: "0.8B",
    sizeGb: 0.5,
    minRamGb: 2,
    category: "chat",
    bucket: "small",
    tokenizerFamily: "qwen35",
    blurb:
      "Smallest Eliza-1 local tier for low-memory phones, USB boots, and CPU fallback.",
  },
  {
    id: "eliza-1-2b",
    displayName: "eliza-1-2b",
    hfRepo: ELIZA_1_REPO,
    ggufFile: "bundles/2b/text/eliza-1-2b-32k.gguf",
    params: "2B",
    sizeGb: 1.4,
    minRamGb: 4,
    category: "chat",
    bucket: "small",
    tokenizerFamily: "qwen35",
    blurb:
      "Recommended first-run Eliza-1 tier for responsive local text and voice.",
    dflashDrafter: "eliza-1-2b-drafter",
  },
  {
    id: "eliza-1-4b",
    displayName: "eliza-1-4b",
    hfRepo: ELIZA_1_REPO,
    ggufFile: "bundles/4b/text/eliza-1-4b-64k.gguf",
    params: "4B",
    sizeGb: 2.6,
    minRamGb: 10,
    category: "chat",
    bucket: "mid",
    tokenizerFamily: "qwen35",
    blurb: "Balanced Eliza-1 local tier for modern laptops and desktops.",
    dflashDrafter: "eliza-1-4b-drafter",
  },
  {
    id: "eliza-1-9b",
    displayName: "eliza-1-9b",
    hfRepo: ELIZA_1_REPO,
    ggufFile: "bundles/9b/text/eliza-1-9b-64k.gguf",
    params: "9B",
    sizeGb: 5.4,
    minRamGb: 12,
    category: "chat",
    bucket: "large",
    tokenizerFamily: "qwen35",
    blurb:
      "Workstation Eliza-1 tier for stronger reasoning with DFlash drafting.",
    dflashDrafter: "eliza-1-9b-drafter",
  },
  {
    id: "eliza-1-27b",
    displayName: "eliza-1-27b",
    hfRepo: ELIZA_1_REPO,
    ggufFile: "bundles/27b/text/eliza-1-27b-128k.gguf",
    params: "27B",
    sizeGb: 16.8,
    minRamGb: 32,
    category: "chat",
    bucket: "large",
    tokenizerFamily: "qwen35",
    blurb: "High-quality Eliza-1 local/cloud tier for GPU workstations.",
    dflashDrafter: "eliza-1-27b-drafter",
  },

  // ─── DFlash sidecars. Not offered as chat models. ────────────────
  {
    id: "eliza-1-2b-drafter",
    displayName: "eliza-1-2b drafter",
    hfRepo: ELIZA_1_REPO,
    ggufFile: "bundles/2b/dflash/drafter-2b.gguf",
    params: "0.8B",
    sizeGb: 0.5,
    minRamGb: 4,
    category: "drafter",
    bucket: "small",
    tokenizerFamily: "qwen35",
    blurb: "DFlash drafter sidecar for eliza-1-2b.",
  },
  {
    id: "eliza-1-4b-drafter",
    displayName: "eliza-1-4b drafter",
    hfRepo: ELIZA_1_REPO,
    ggufFile: "bundles/4b/dflash/drafter-4b.gguf",
    params: "0.8B",
    sizeGb: 0.7,
    minRamGb: 10,
    category: "drafter",
    bucket: "small",
    tokenizerFamily: "qwen35",
    blurb: "DFlash drafter sidecar for eliza-1-4b.",
  },
  {
    id: "eliza-1-9b-drafter",
    displayName: "eliza-1-9b drafter",
    hfRepo: ELIZA_1_REPO,
    ggufFile: "bundles/9b/dflash/drafter-9b.gguf",
    params: "2B",
    sizeGb: 1.4,
    minRamGb: 12,
    category: "drafter",
    bucket: "mid",
    tokenizerFamily: "qwen35",
    blurb: "DFlash drafter sidecar for eliza-1-9b.",
  },
  {
    id: "eliza-1-27b-drafter",
    displayName: "eliza-1-27b drafter",
    hfRepo: ELIZA_1_REPO,
    ggufFile: "bundles/27b/dflash/drafter-27b.gguf",
    params: "4B",
    sizeGb: 2.6,
    minRamGb: 32,
    category: "drafter",
    bucket: "mid",
    tokenizerFamily: "qwen35",
    blurb: "DFlash drafter sidecar for eliza-1-27b.",
  },
];

export function findCatalogModel(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/**
 * Construct the HuggingFace resolve URL. Respects `USBELIZA_HF_BASE_URL`
 * for self-hosted mirrors and tests; never trims the GGUF file path because
 * some repos use a `text/` or `quantized/` subdir.
 */
export function buildHuggingFaceResolveUrl(model: CatalogModel): string {
  const base =
    process.env.USBELIZA_HF_BASE_URL?.trim().replace(/\/+$/, "") ??
    Bun.env.USBELIZA_HF_BASE_URL?.trim().replace(/\/+$/, "") ??
    "https://huggingface.co";
  const encodedPath = model.ggufFile
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/${model.hfRepo}/resolve/main/${encodedPath}?download=true`;
}

/**
 * Memory-aware tier filter: returns the chat-eligible tiers a host with
 * `memTotalGb` GiB of RAM can actually run, sorted largest-first so the
 * picker can show the best fit at the top. Always includes the baseline
 * `eliza-1-0_8b` even if memTotalGb < 6 — without it the picker can't offer
 * anything and the boot stalls. (We already require minRamGb=2 for
 * eliza-1-0_8b, so any usable host trivially clears the gate.)
 */
export function pickEligibleTiers(memTotalGb: number): CatalogModel[] {
  const HEADROOM_GB = 4;
  const chatTiers = MODEL_CATALOG.filter((m) => m.category === "chat");
  const eligible = chatTiers.filter(
    (m) => m.minRamGb + HEADROOM_GB <= memTotalGb,
  );
  if (eligible.find((m) => m.id === BASELINE_MODEL_ID) === undefined) {
    const baseline = findCatalogModel(BASELINE_MODEL_ID);
    if (baseline !== undefined) eligible.push(baseline);
  }
  return eligible.sort((a, b) => b.minRamGb - a.minRamGb);
}

/**
 * The drafter model for a given DFlash-enabled target. Returns undefined
 * for non-DFlash tiers, or if the catalog is mis-paired (defensive).
 */
export function findDflashDrafter(
  target: CatalogModel,
): CatalogModel | undefined {
  if (target.dflashDrafter === undefined) return undefined;
  const drafter = findCatalogModel(target.dflashDrafter);
  if (drafter === undefined) return undefined;
  if (drafter.tokenizerFamily !== target.tokenizerFamily) {
    throw new Error(
      `catalog inconsistency: drafter ${drafter.id} (${drafter.tokenizerFamily}) cannot draft for ` +
        `target ${target.id} (${target.tokenizerFamily}) — tokenizer families must match`,
    );
  }
  return drafter;
}
