/**
 * Eliza-curated local model catalog.
 *
 * Eliza-1 is the only default-eligible model line. The user-facing model
 * ids are size-first (`eliza-1-0_8b`, `eliza-1-2b`, `eliza-1-4b`,
 * `eliza-1-9b`, `eliza-1-27b`, `eliza-1-27b-256k`, `eliza-1-27b-1m`). The recommendation
 * engine picks one of these tiers based on hardware. The long-context 27B
 * variants (`27b-256k`, `27b-1m`) only surface on hosts whose RAM/VRAM can
 * hold the KV cache at that window — `27b-1m` is GH200-class.
 *
 * HF-search results from outside `elizaos/eliza-1-*` MUST never be
 * marked default-eligible (handled by `hf-search.ts`, which produces
 * entries that are absent from `DEFAULT_ELIGIBLE_MODEL_IDS`).
 *
 * When upstream naming conventions drift, update `ggufFile` here — we
 * rely on the exact filename for resolved-URL construction in the
 * downloader.
 *
 * Shared-vocabulary note: every text-bearing entry below (the `chat` tier
 * entries AND their `dflash-drafter` companions) carries
 * `tokenizerFamily: "eliza1"` — they are all Qwen3.5/Qwen3.6-lineage and
 * share the same Qwen3.5 vocabulary + merges table. The drafter GGUFs ship *without* their
 * own `tokenizer.ggml.merges`; the runtime injects it from the tier's text
 * GGUF at load time (`resolveDflashDrafter` in
 * `packages/app-core/src/services/local-inference/dflash-server.ts`). The same
 * vocab also covers the bundled text/vision model and DFlash drafter. ASR
 * emits text strings through a separate Qwen3-ASR vocabulary, so ASR output is
 * re-tokenized at the text boundary. The shared *vocabulary* does NOT mean a
 * shared *token-embedding tensor* (each GGUF has its own `token_embd.weight`),
 * and "shared mmap region for weights" in inference/AGENTS.md §4 is per-file
 * dedup — only text+vision share one GGUF/region today; the OmniVoice text
 * decoder, ASR, embedding, and drafter are separate files. Deduplicating the
 * vocab tensor itself would need a fused-architecture container, which is out
 * of scope per inference/AGENTS.md §2. Full analysis:
 * `packages/inference/reports/porting/2026-05-11/qwen-backbone-unification.md`.
 */

import type { CatalogModel, LocalRuntimeKernel } from "./types.js";

/**
 * Eliza-1 tier identifiers, in tier-matrix order. Source of truth for
 * the recommendation ladders and the default-eligible set.
 */
export const ELIZA_1_TIER_IDS = [
  "eliza-1-0_8b",
  "eliza-1-2b",
  "eliza-1-4b",
  "eliza-1-9b",
  "eliza-1-27b",
  "eliza-1-27b-256k",
  "eliza-1-27b-1m",
] as const;

export type Eliza1TierId = (typeof ELIZA_1_TIER_IDS)[number];

/**
 * The model id the engine auto-loads on first run when no preference is
 * set. Resolves to the `eliza-1-2b` tier - the smallest Eliza-1 tier
 * that fits the broadest range of hardware (modern phone or laptop).
 * Hosts that can't fit `eliza-1-2b` get the `eliza-1-0_8b` fallback via
 * the recommendation ladder.
 */
export const FIRST_RUN_DEFAULT_MODEL_ID: Eliza1TierId = "eliza-1-2b";

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

/**
 * Per-tier "base, not fine-tuned" provenance — the upstream HuggingFace
 * repos each shipped bundle component is GGUF-converted + Milady-optimized
 * from. Eliza-1 v1 = these exact base weights, optimized (every quant/kernel
 * trick in `packages/inference/AGENTS.md` §3), NOT fine-tuned. This must
 * agree with `provenance.sourceModels` in the tier's
 * `eliza-1.manifest.json`. Fine-tuning lands in v2.
 *
 * Notes:
 * - 0.6B / 1.7B / 4B / 9B text use Qwen3.5 Small via the current public GGUF
 *   mirrors. 27B uses Qwen3.6. This replaces the old small-tier Qwen3
 *   placeholders; do not relabel those old-vocab files as Eliza-1 release
 *   candidates.
 * - 0_8b has no dedicated `embedding` component — it pools from the text
 *   backbone with `--pooling last` (inference/AGENTS.md §1).
 * - the drafter is distilled (KD, not fine-tuning of the target) FROM the
 *   tier's base text model and published under `elizaos/eliza-1-<tier>`.
 */
type SourceComponentMap = NonNullable<
  CatalogModel["sourceModel"]
>["components"];

function sourceModelForTier(id: Eliza1TierId): CatalogModel["sourceModel"] {
  const omnivoice = { repo: "Serveurperso/OmniVoice-GGUF" } as const;
  const silero = { repo: "onnx-community/silero-vad" } as const;
  const embedding = { repo: "Qwen/Qwen3-Embedding-0.6B-GGUF" } as const;
  const asrSmall = { repo: "ggml-org/Qwen3-ASR-0.6B-GGUF" } as const;
  const asrLarge = { repo: "ggml-org/Qwen3-ASR-1.7B-GGUF" } as const;

  const textByTier: Record<Eliza1TierId, { repo: string; file?: string }> = {
    "eliza-1-0_8b": {
      repo: "unsloth/Qwen3.5-0.8B-GGUF",
      file: "Qwen3.5-0.8B-Q8_0.gguf",
    },
    "eliza-1-2b": {
      repo: "unsloth/Qwen3.5-2B-GGUF",
      file: "Qwen3.5-2B-Q8_0.gguf",
    },
    "eliza-1-4b": {
      repo: "unsloth/Qwen3.5-4B-GGUF",
      file: "Qwen3.5-4B-Q8_0.gguf",
    },
    "eliza-1-9b": {
      repo: "unsloth/Qwen3.5-9B-GGUF",
      file: "Qwen3.5-9B-Q4_K_M.gguf",
    },
    "eliza-1-27b": {
      repo: "batiai/Qwen3.6-27B-GGUF",
      file: "Qwen-Qwen3.6-27B-Q4_K_M.gguf",
    },
    "eliza-1-27b-256k": {
      repo: "batiai/Qwen3.6-27B-GGUF",
      file: "Qwen-Qwen3.6-27B-Q4_K_M.gguf",
    },
    "eliza-1-27b-1m": {
      repo: "batiai/Qwen3.6-27B-GGUF",
      file: "Qwen-Qwen3.6-27B-Q4_K_M.gguf",
    },
  };
  const visionByTier: Partial<
    Record<Eliza1TierId, { repo: string; file?: string }>
  > = {
    "eliza-1-0_8b": {
      repo: "unsloth/Qwen3.5-0.8B-GGUF",
      file: "mmproj-F16.gguf",
    },
    "eliza-1-2b": { repo: "unsloth/Qwen3.5-2B-GGUF", file: "mmproj-F16.gguf" },
    "eliza-1-4b": { repo: "unsloth/Qwen3.5-4B-GGUF", file: "mmproj-F16.gguf" },
    "eliza-1-9b": { repo: "unsloth/Qwen3.5-9B-GGUF", file: "mmproj-F16.gguf" },
    "eliza-1-27b": {
      repo: "batiai/Qwen3.6-27B-GGUF",
      file: "mmproj-Qwen-Qwen3.6-27B-Q6_K.gguf",
    },
    "eliza-1-27b-256k": {
      repo: "batiai/Qwen3.6-27B-GGUF",
      file: "mmproj-Qwen-Qwen3.6-27B-Q6_K.gguf",
    },
    "eliza-1-27b-1m": {
      repo: "batiai/Qwen3.6-27B-GGUF",
      file: "mmproj-Qwen-Qwen3.6-27B-Q6_K.gguf",
    },
  };
  const usesLargeAsr = id.startsWith("eliza-1-27b");
  const components: SourceComponentMap = {
    text: textByTier[id],
    voice: omnivoice,
    asr: usesLargeAsr ? asrLarge : asrSmall,
    vad: silero,
    drafter: {
      repo: `elizaos/${id}`,
      file: `dflash/drafter-${id.slice("eliza-1-".length)}.gguf`,
    },
  };
  if (id !== "eliza-1-0_8b") components.embedding = embedding;
  if (visionByTier[id]) components.vision = visionByTier[id];
  return { finetuned: false, components };
}

/**
 * Default KV-cache quantization types per tier, per `packages/inference/AGENTS.md`
 * §3 items 1–3. Every Eliza-1 tier runs at a context length > 8k, so the
 * mandated layout is QJL on the K-cache (`qjl1_256`) and PolarQuant on the
 * V-cache (`q4_polar`); the TurboQuant K/V types (`turbo3_0` for tiny Q3
 * tiers, `turbo4_0` for the larger Q4 tiers) are the <=8k fallback and are
 * not used by any current tier. These are catalog defaults — the operator's
 * `ELIZA_DFLASH_CACHE_TYPE_K` / `_V` env vars still override them. The
 * dflash-server refuses a type the shipped binary's `CAPABILITIES.json`
 * doesn't advertise, so a build missing the QJL/Polar kernels fails loudly
 * rather than silently running an f16 cache.
 */
function kvCacheForContext(
  contextLength: number,
): NonNullable<CatalogModel["runtime"]>["kvCache"] {
  if (contextLength > 8192) {
    return {
      typeK: "qjl1_256",
      typeV: "q4_polar",
      requiresFork: "buun-llama-cpp",
    };
  }
  return {
    typeK: "turbo3_0",
    typeV: "turbo4_0",
    requiresFork: "buun-llama-cpp",
  };
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
    kvCache: kvCacheForContext(contextLength),
    dflash: {
      drafterModelId: drafterId(id),
      specType: "dflash",
      contextSize: contextLength,
      draftContextSize: Math.min(contextLength, 65536),
      draftMin: 2,
      draftMax:
        id === "eliza-1-0_8b" || id === "eliza-1-2b" || id === "eliza-1-4b"
          ? 4
          : contextLength >= 131072
            ? 8
            : 6,
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
    hfRepo: `elizaos/${args.id}`,
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
    blurb: "Companion drafter file.",
  };
}

export const MODEL_CATALOG: CatalogModel[] = [
  // eliza-1-0_8b (low-RAM phones, CPU fallback)
  {
    id: "eliza-1-0_8b",
    displayName: "eliza-1-0_8b",
    hfRepo: "elizaos/eliza-1-0_8b",
    ggufFile: "text/eliza-1-0_8b-32k.gguf",
    bundleManifestFile: "eliza-1.manifest.json",
    params: "0.8B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 0.5,
    minRamGb: 2,
    category: "chat",
    bucket: "small",
    contextLength: 32768,
    tokenizerFamily: "eliza1",
    companionModelIds: ["eliza-1-0_8b-drafter"],
    sourceModel: sourceModelForTier("eliza-1-0_8b"),
    runtime: runtimeFor("eliza-1-0_8b", 32768),
    blurb:
      "eliza-1-0_8b - low-RAM phones and CPU-only fallback with the optimized local runtime.",
  },
  drafterCompanion({
    id: "eliza-1-0_8b",
    displayName: "eliza-1-0_8b",
    ggufFile: "dflash/drafter-0_8b.gguf",
    params: "0.8B",
    sizeGb: 0.25,
    minRamGb: 2,
    bucket: "small",
  }),

  // eliza-1-2b (modern phones)
  {
    id: "eliza-1-2b",
    displayName: "eliza-1-2b",
    hfRepo: "elizaos/eliza-1-2b",
    ggufFile: "text/eliza-1-2b-32k.gguf",
    bundleManifestFile: "eliza-1.manifest.json",
    params: "2B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 1.2,
    minRamGb: 4,
    category: "chat",
    bucket: "small",
    contextLength: 32768,
    tokenizerFamily: "eliza1",
    companionModelIds: ["eliza-1-2b-drafter"],
    sourceModel: sourceModelForTier("eliza-1-2b"),
    runtime: runtimeFor("eliza-1-2b", 32768),
    blurb:
      "eliza-1-2b - modern phone default with text and voice prepared for the optimized local runtime.",
  },
  drafterCompanion({
    id: "eliza-1-2b",
    displayName: "eliza-1-2b",
    ggufFile: "dflash/drafter-2b.gguf",
    params: "0.8B",
    sizeGb: 0.35,
    minRamGb: 4,
    bucket: "small",
  }),

  // eliza-1-4b (flagship phones, small desktops)
  {
    id: "eliza-1-4b",
    displayName: "eliza-1-4b",
    hfRepo: "elizaos/eliza-1-4b",
    ggufFile: "text/eliza-1-4b-64k.gguf",
    bundleManifestFile: "eliza-1.manifest.json",
    params: "4B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 2.8,
    minRamGb: 8,
    category: "chat",
    bucket: "mid",
    contextLength: 65536,
    tokenizerFamily: "eliza1",
    companionModelIds: ["eliza-1-4b-drafter"],
    sourceModel: sourceModelForTier("eliza-1-4b"),
    runtime: runtimeFor("eliza-1-4b", 65536),
    blurb:
      "eliza-1-4b - flagship-phone and small-desktop tier with text, voice, and vision in the optimized local runtime.",
  },
  drafterCompanion({
    id: "eliza-1-4b",
    displayName: "eliza-1-4b",
    ggufFile: "dflash/drafter-4b.gguf",
    params: "0.8B",
    sizeGb: 0.35,
    minRamGb: 8,
    bucket: "mid",
  }),

  // eliza-1-9b (laptops, 24 GB phones, 48 GB Mac)
  {
    id: "eliza-1-9b",
    displayName: "eliza-1-9b",
    hfRepo: "elizaos/eliza-1-9b",
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
    sourceModel: sourceModelForTier("eliza-1-9b"),
    runtime: runtimeFor("eliza-1-9b", 65536),
    blurb:
      "eliza-1-9b - laptop / 24 GB phone / 48 GB Mac default with text, voice, and vision in the optimized local runtime.",
  },
  drafterCompanion({
    id: "eliza-1-9b",
    displayName: "eliza-1-9b",
    ggufFile: "dflash/drafter-9b.gguf",
    params: "2B",
    sizeGb: 1.2,
    minRamGb: 12,
    bucket: "mid",
  }),

  // eliza-1-27b (96 GB+ Mac, high-VRAM desktop)
  {
    id: "eliza-1-27b",
    displayName: "eliza-1-27b",
    hfRepo: "elizaos/eliza-1-27b",
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
    sourceModel: sourceModelForTier("eliza-1-27b"),
    runtime: runtimeFor("eliza-1-27b", 131072),
    blurb:
      "eliza-1-27b - 96 GB+ Mac and high-VRAM desktop default with text, voice, vision, and 128k context.",
  },
  drafterCompanion({
    id: "eliza-1-27b",
    displayName: "eliza-1-27b",
    ggufFile: "dflash/drafter-27b.gguf",
    params: "4B",
    sizeGb: 2.4,
    minRamGb: 32,
    bucket: "large",
  }),

  // eliza-1-27b-256k (workstation / server)
  {
    id: "eliza-1-27b-256k",
    displayName: "eliza-1-27b-256k",
    hfRepo: "elizaos/eliza-1-27b-256k",
    ggufFile: "text/eliza-1-27b-256k.gguf",
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
    sourceModel: sourceModelForTier("eliza-1-27b-256k"),
    runtime: runtimeFor("eliza-1-27b-256k", 262144),
    blurb:
      "eliza-1-27b-256k - workstation tier with the largest context window in the line.",
  },
  drafterCompanion({
    id: "eliza-1-27b-256k",
    displayName: "eliza-1-27b-256k",
    ggufFile: "dflash/drafter-27b-256k.gguf",
    params: "4B",
    sizeGb: 2.4,
    minRamGb: 96,
    bucket: "large",
  }),

  // eliza-1-27b-1m (GH200-class — 1M context). The KV cache at a 1M window
  // does not fit consumer hardware even at QJL+Polar compression; this tier
  // is only recommended on hosts with very large unified/HBM memory. On
  // every other device the recommender's RAM gate (`minRamGb`) excludes it,
  // which is the intended "refuse on devices that can't fit it, surface it
  // on the ones that can" behavior. The K-cache rides the trellis path
  // (`turbo3_tcq`, declared via `requiresKernel` through `runtimeFor`).
  {
    id: "eliza-1-27b-1m",
    displayName: "eliza-1-27b-1m",
    hfRepo: "elizaos/eliza-1-27b-1m",
    ggufFile: "text/eliza-1-27b-1m.gguf",
    bundleManifestFile: "eliza-1.manifest.json",
    params: "27B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 16.8,
    minRamGb: 200,
    category: "chat",
    bucket: "large",
    contextLength: 1_048_576,
    tokenizerFamily: "eliza1",
    companionModelIds: ["eliza-1-27b-1m-drafter"],
    sourceModel: sourceModelForTier("eliza-1-27b-1m"),
    runtime: runtimeFor("eliza-1-27b-1m", 1_048_576),
    blurb:
      "eliza-1-27b-1m - GH200-class server tier with a 1M-token context window.",
  },
  drafterCompanion({
    id: "eliza-1-27b-1m",
    displayName: "eliza-1-27b-1m",
    ggufFile: "dflash/drafter-27b-1m.gguf",
    params: "4B",
    sizeGb: 2.4,
    minRamGb: 200,
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
  // `text/eliza-1-2b-32k.gguf` keep their slashes.
  const encodedPath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/${model.hfRepo}/resolve/main/${encodedPath}?download=true`;
}

export function buildHuggingFaceResolveUrl(model: CatalogModel): string {
  return buildHuggingFaceResolveUrlForPath(model, model.ggufFile);
}
