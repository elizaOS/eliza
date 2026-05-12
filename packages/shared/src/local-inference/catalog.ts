/**
 * Eliza-curated local model catalog.
 *
 * Eliza-1 is the only default-eligible model line. User-facing model ids are
 * size-first: `eliza-1-0_6b`, `eliza-1-1_7b`, `eliza-1-4b`, `eliza-1-9b`,
 * `eliza-1-27b`, `eliza-1-27b-256k`, and `eliza-1-27b-1m`.
 *
 * HF-search results from outside `elizaos/eliza-1-*` must never be marked
 * default-eligible. The final downloadable GGUF bundles live under the
 * `elizaos` organization; the `sourceModel` block records upstream provenance.
 */

import type { CatalogModel, LocalRuntimeKernel } from "./types.js";

export const ELIZA_1_TIER_IDS = [
  "eliza-1-0_6b",
  "eliza-1-1_7b",
  "eliza-1-4b",
  "eliza-1-9b",
  "eliza-1-27b",
  "eliza-1-27b-256k",
  "eliza-1-27b-1m",
] as const;

export type Eliza1TierId = (typeof ELIZA_1_TIER_IDS)[number];

export const FIRST_RUN_DEFAULT_MODEL_ID: Eliza1TierId = "eliza-1-1_7b";

export const DEFAULT_ELIGIBLE_MODEL_IDS: ReadonlySet<string> = new Set(
  ELIZA_1_TIER_IDS,
);

export function isDefaultEligibleId(id: string): boolean {
  return DEFAULT_ELIGIBLE_MODEL_IDS.has(id);
}

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

type SourceComponentMap = NonNullable<
  CatalogModel["sourceModel"]
>["components"];

/**
 * Voice backend for a bundle. OmniVoice is the historical default — fully
 * cloneable per-user voices via the fused libelizainference build. Kokoro
 * is the streaming-first alternative: 24 kHz output, ~97ms CPU TTFB, fixed
 * voice packs (no cloning). The runtime selector (`voice/kokoro/runtime-
 * selection.ts`) picks at engine-arm time; this field is just the catalog
 * advertisement of which option(s) the bundle ships artifacts for.
 */
export type VoiceBackendId = "omnivoice" | "kokoro";

/** Per-bundle voice backend metadata. */
export const ELIZA_1_VOICE_BACKENDS: Record<
  Eliza1TierId,
  ReadonlyArray<VoiceBackendId>
> = {
  "eliza-1-0_6b": ["omnivoice", "kokoro"],
  "eliza-1-1_7b": ["omnivoice", "kokoro"],
  "eliza-1-4b": ["omnivoice", "kokoro"],
  "eliza-1-9b": ["omnivoice", "kokoro"],
  "eliza-1-27b": ["omnivoice", "kokoro"],
  "eliza-1-27b-256k": ["omnivoice", "kokoro"],
  "eliza-1-27b-1m": ["omnivoice", "kokoro"],
};

/** Source repo for the Kokoro-82M ONNX export — same artifact across tiers. */
export const KOKORO_SOURCE_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";

function sourceModelForTier(id: Eliza1TierId): CatalogModel["sourceModel"] {
  const omnivoice = { repo: "Serveurperso/OmniVoice-GGUF" } as const;
  const silero = { repo: "onnx-community/silero-vad" } as const;
  const embedding = { repo: "Qwen/Qwen3-Embedding-0.6B-GGUF" } as const;
  const asrSmall = { repo: "ggml-org/Qwen3-ASR-0.6B-GGUF" } as const;
  const asrLarge = { repo: "ggml-org/Qwen3-ASR-1.7B-GGUF" } as const;

  const textByTier: Record<Eliza1TierId, { repo: string; file?: string }> = {
    "eliza-1-0_6b": { repo: "Qwen/Qwen3.5-0.6B" },
    "eliza-1-1_7b": { repo: "Qwen/Qwen3.5-1.7B" },
    "eliza-1-4b": { repo: "Qwen/Qwen3.5-4B" },
    "eliza-1-9b": { repo: "Qwen/Qwen3.5-9B" },
    "eliza-1-27b": { repo: "Qwen/Qwen3.6-27B" },
    "eliza-1-27b-256k": { repo: "Qwen/Qwen3.6-27B" },
    "eliza-1-27b-1m": { repo: "Qwen/Qwen3.6-27B" },
  };

  const visionByTier: Partial<
    Record<Eliza1TierId, { repo: string; file?: string }>
  > = {
    "eliza-1-4b": { repo: "Qwen/Qwen3.5-4B" },
    "eliza-1-9b": { repo: "Qwen/Qwen3.5-9B" },
    "eliza-1-27b": { repo: "Qwen/Qwen3.6-27B" },
    "eliza-1-27b-256k": { repo: "Qwen/Qwen3.6-27B" },
    "eliza-1-27b-1m": { repo: "Qwen/Qwen3.6-27B" },
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
  if (id !== "eliza-1-0_6b") components.embedding = embedding;
  if (visionByTier[id]) components.vision = visionByTier[id];
  return { finetuned: false, components };
}

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

/**
 * Per-tier `--ctx-checkpoints N --ctx-checkpoint-interval M` defaults for
 * upstream llama.cpp's mid-prefill snapshot feature (used by the voice
 * optimistic-rollback path). Larger tiers retain more snapshots since the
 * context window is larger and each checkpoint costs proportionally less
 * relative to a full restart. The server-side flag is conditional on a
 * runtime probe — these are catalog defaults only.
 */
function ctxCheckpointsForTier(id: Eliza1TierId): {
  ctxCheckpoints: number;
  ctxCheckpointInterval: number;
} {
  if (id === "eliza-1-0_6b" || id === "eliza-1-1_7b") {
    return { ctxCheckpoints: 4, ctxCheckpointInterval: 4096 };
  }
  if (id === "eliza-1-4b" || id === "eliza-1-9b") {
    return { ctxCheckpoints: 8, ctxCheckpointInterval: 8192 };
  }
  // 27b tiers — including extended-context 256k/1m.
  return { ctxCheckpoints: 16, ctxCheckpointInterval: 8192 };
}

function runtimeFor(
  id: Eliza1TierId,
  contextLength: number,
): CatalogModel["runtime"] {
  const ctxCkpt = ctxCheckpointsForTier(id);
  return {
    preferredBackend: "llama-server",
    optimizations: {
      parallel: contextLength >= 131072 ? 8 : 4,
      flashAttention: true,
      mlock: contextLength >= 131072,
      requiresKernel: requiredKernelsForContext(contextLength),
      ctxCheckpoints: ctxCkpt.ctxCheckpoints,
      ctxCheckpointInterval: ctxCkpt.ctxCheckpointInterval,
    },
    kvCache: kvCacheForContext(contextLength),
    dflash: {
      drafterModelId: drafterId(id),
      specType: "dflash",
      contextSize: contextLength,
      draftContextSize: Math.min(contextLength, 65536),
      draftMin: 2,
      draftMax:
        id === "eliza-1-0_6b" || id === "eliza-1-1_7b" || id === "eliza-1-4b"
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
    tokenizerFamily: "qwen35",
    blurb: "Companion drafter file.",
  };
}

export const MODEL_CATALOG: CatalogModel[] = [
  {
    id: "eliza-1-0_6b",
    displayName: "eliza-1-0_6b",
    hfRepo: "elizaos/eliza-1-0_6b",
    ggufFile: "text/eliza-1-0_6b-32k.gguf",
    bundleManifestFile: "eliza-1.manifest.json",
    params: "0.6B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 0.7,
    minRamGb: 2,
    category: "chat",
    bucket: "small",
    contextLength: 32768,
    tokenizerFamily: "qwen35",
    companionModelIds: ["eliza-1-0_6b-drafter"],
    sourceModel: sourceModelForTier("eliza-1-0_6b"),
    runtime: runtimeFor("eliza-1-0_6b", 32768),
    blurb:
      "eliza-1-0_6b - low-RAM phones and CPU-only fallback with the optimized local runtime.",
  },
  drafterCompanion({
    id: "eliza-1-0_6b",
    displayName: "eliza-1-0_6b",
    ggufFile: "dflash/drafter-0_6b.gguf",
    params: "0.6B",
    sizeGb: 0.3,
    minRamGb: 2,
    bucket: "small",
  }),
  {
    id: "eliza-1-1_7b",
    displayName: "eliza-1-1_7b",
    hfRepo: "elizaos/eliza-1-1_7b",
    ggufFile: "text/eliza-1-1_7b-32k.gguf",
    bundleManifestFile: "eliza-1.manifest.json",
    params: "1.7B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 1.5,
    minRamGb: 4,
    category: "chat",
    bucket: "small",
    contextLength: 32768,
    tokenizerFamily: "qwen35",
    companionModelIds: ["eliza-1-1_7b-drafter"],
    sourceModel: sourceModelForTier("eliza-1-1_7b"),
    runtime: runtimeFor("eliza-1-1_7b", 32768),
    blurb:
      "eliza-1-1_7b - modern phone default with text and voice prepared for the optimized local runtime.",
  },
  drafterCompanion({
    id: "eliza-1-1_7b",
    displayName: "eliza-1-1_7b",
    ggufFile: "dflash/drafter-1_7b.gguf",
    params: "0.6B",
    sizeGb: 0.35,
    minRamGb: 4,
    bucket: "small",
  }),
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
    tokenizerFamily: "qwen35",
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
    params: "0.6B",
    sizeGb: 0.35,
    minRamGb: 8,
    bucket: "mid",
  }),
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
    tokenizerFamily: "qwen35",
    companionModelIds: ["eliza-1-9b-drafter"],
    sourceModel: sourceModelForTier("eliza-1-9b"),
    runtime: runtimeFor("eliza-1-9b", 65536),
    gpuProfile: "rtx-3090",
    blurb:
      "eliza-1-9b - laptop / 24 GB phone / 48 GB Mac default with text, voice, and vision in the optimized local runtime.",
  },
  drafterCompanion({
    id: "eliza-1-9b",
    displayName: "eliza-1-9b",
    ggufFile: "dflash/drafter-9b.gguf",
    params: "1.7B",
    sizeGb: 1.2,
    minRamGb: 12,
    bucket: "mid",
  }),
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
    tokenizerFamily: "qwen35",
    companionModelIds: ["eliza-1-27b-drafter"],
    sourceModel: sourceModelForTier("eliza-1-27b"),
    runtime: runtimeFor("eliza-1-27b", 131072),
    gpuProfile: "rtx-4090",
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
    tokenizerFamily: "qwen35",
    companionModelIds: ["eliza-1-27b-256k-drafter"],
    sourceModel: sourceModelForTier("eliza-1-27b-256k"),
    runtime: runtimeFor("eliza-1-27b-256k", 262144),
    gpuProfile: "rtx-5090",
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
    tokenizerFamily: "qwen35",
    companionModelIds: ["eliza-1-27b-1m-drafter"],
    sourceModel: sourceModelForTier("eliza-1-27b-1m"),
    runtime: runtimeFor("eliza-1-27b-1m", 1_048_576),
    gpuProfile: "h200",
    blurb:
      "eliza-1-27b-1m - H200-class server tier with a 1M-token context window and memory-optimized KV cache layout for 141 GiB HBM3e hosts.",
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

export function buildHuggingFaceResolveUrlForPath(
  model: CatalogModel,
  filePath: string,
): string {
  if (model.hub === "modelscope") {
    const base =
      process.env.ELIZA_MODELSCOPE_BASE_URL?.trim().replace(/\/+$/, "") ||
      "https://www.modelscope.cn";
    const encodedPath = filePath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${base}/models/${model.hfRepo}/resolve/master/${encodedPath}`;
  }
  const base =
    process.env.ELIZA_HF_BASE_URL?.trim().replace(/\/+$/, "") ||
    "https://huggingface.co";
  const encodedPath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/${model.hfRepo}/resolve/main/${encodedPath}?download=true`;
}

export function buildHuggingFaceResolveUrl(model: CatalogModel): string {
  return buildHuggingFaceResolveUrlForPath(model, model.ggufFile);
}
