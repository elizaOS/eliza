/**
 * Eliza-curated local model catalog.
 *
 * The active mobile release line is Qwen3.5 only: `eliza-1-0_8b` for the
 * smallest local tier and `eliza-1-2b` for the first-run mid tier. Older
 * Qwen3 ids (`0_6b`, `1_7b`) are intentionally absent from the canonical
 * catalog so recommendation, download, and simulator smoke paths cannot drift
 * back onto them.
 */

import type {
  CatalogModel,
  CatalogQuantizationId,
  CatalogQuantizationVariant,
  LocalRuntimeKernel,
} from "./types.js";

export const ELIZA_1_HF_REPO = "elizaos/eliza-1" as const;

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

export const ELIZA_1_RELEASE_TIER_IDS = [
  "eliza-1-0_8b",
  "eliza-1-2b",
] as const satisfies ReadonlyArray<Eliza1TierId>;

/**
 * First-run default: the smallest mid-tier Qwen3.5 bundle. The 0.8B tier stays
 * visible and is what mobile smoke tests use when they need the smallest model.
 */
export const FIRST_RUN_DEFAULT_MODEL_ID: Eliza1TierId = "eliza-1-2b";

export const DEFAULT_ELIGIBLE_MODEL_IDS: ReadonlySet<string> = new Set(
  ELIZA_1_RELEASE_TIER_IDS,
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

function tierSlug(id: Eliza1TierId): string {
  return id.slice("eliza-1-".length);
}

function bundleRemotePrefix(id: Eliza1TierId): string {
  return `bundles/${tierSlug(id)}`;
}

function bundlePath(_id: Eliza1TierId, rel: string): string {
  return rel;
}

function bundleRemotePath(id: Eliza1TierId, rel: string): string {
  return `${bundleRemotePrefix(id)}/${rel}`;
}

type SourceComponentMap = NonNullable<
  CatalogModel["sourceModel"]
>["components"];

export type VoiceBackendId = "omnivoice" | "kokoro";

export const ELIZA_1_VOICE_BACKENDS: Record<
  Eliza1TierId,
  ReadonlyArray<VoiceBackendId>
> = {
  "eliza-1-0_8b": ["kokoro"],
  "eliza-1-2b": ["kokoro", "omnivoice"],
  "eliza-1-4b": ["kokoro"],
  "eliza-1-9b": ["kokoro", "omnivoice"],
  "eliza-1-27b": ["omnivoice"],
  "eliza-1-27b-256k": ["omnivoice"],
  "eliza-1-27b-1m": ["omnivoice"],
};

export const KOKORO_SOURCE_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";

function sourceModelForTier(id: Eliza1TierId): CatalogModel["sourceModel"] {
  const omnivoice = { repo: "Serveurperso/OmniVoice-GGUF" } as const;
  const kokoro = { repo: KOKORO_SOURCE_REPO } as const;
  const silero = { repo: "onnx-community/silero-vad" } as const;
  const embedding = {
    repo: ELIZA_1_HF_REPO,
    file: bundleRemotePath(id, "embedding/eliza-1-embedding.gguf"),
  } as const;
  const asrSmall = {
    repo: ELIZA_1_HF_REPO,
    file: bundleRemotePath(id, "asr/eliza-1-asr.gguf"),
  } as const;
  const asrLarge = {
    repo: ELIZA_1_HF_REPO,
    file: bundleRemotePath(id, "asr/eliza-1-asr-large.gguf"),
  } as const;
  const plannedText = {
    repo: ELIZA_1_HF_REPO,
    file: bundleRemotePath(id, `text/eliza-1-${tierSlug(id)}.gguf`),
  } as const;
  const plannedVision = {
    repo: ELIZA_1_HF_REPO,
    file: bundleRemotePath(id, `vision/mmproj-${tierSlug(id)}.gguf`),
  } as const;

  const textByTier: Record<Eliza1TierId, { repo: string; file?: string }> = {
    "eliza-1-0_8b": { repo: "Qwen/Qwen3.5-0.8B" },
    "eliza-1-2b": { repo: "Qwen/Qwen3.5-2B-Base" },
    "eliza-1-4b": { repo: "Qwen/Qwen3.5-4B" },
    "eliza-1-9b": plannedText,
    "eliza-1-27b": plannedText,
    "eliza-1-27b-256k": plannedText,
    "eliza-1-27b-1m": plannedText,
  };

  const visionByTier: Partial<
    Record<Eliza1TierId, { repo: string; file?: string }>
  > = {
    "eliza-1-4b": { repo: "Qwen/Qwen3.5-4B" },
    "eliza-1-9b": plannedVision,
    "eliza-1-27b": plannedVision,
    "eliza-1-27b-256k": plannedVision,
  };

  const usesLargeAsr = id.startsWith("eliza-1-27b");
  const primaryVoice =
    ELIZA_1_VOICE_BACKENDS[id][0] === "kokoro" ? kokoro : omnivoice;
  const components: SourceComponentMap = {
    text: textByTier[id],
    voice: primaryVoice,
    asr: usesLargeAsr ? asrLarge : asrSmall,
    vad: silero,
    drafter: {
      repo: ELIZA_1_HF_REPO,
      file: bundleRemotePath(id, `dflash/drafter-${tierSlug(id)}.gguf`),
    },
  };
  if (id !== "eliza-1-0_8b") components.embedding = embedding;
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

function ctxCheckpointsForTier(id: Eliza1TierId): {
  ctxCheckpoints: number;
  ctxCheckpointInterval: number;
} {
  if (id === "eliza-1-0_8b" || id === "eliza-1-2b") {
    return { ctxCheckpoints: 4, ctxCheckpointInterval: 4096 };
  }
  if (id === "eliza-1-4b" || id === "eliza-1-9b") {
    return { ctxCheckpoints: 8, ctxCheckpointInterval: 8192 };
  }
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
        id === "eliza-1-0_8b" ||
        id === "eliza-1-2b" ||
        id === "eliza-1-4b"
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

const QUANT_SUFFIX: Record<CatalogQuantizationId, string> = {
  q4_k_m: "q4_k_m",
  q6_k: "q6_k",
  q8_0: "q8_0",
};

function textQuantizationMatrix(args: {
  primaryGgufFile: string;
  q4SizeGb: number;
  q4MinRamGb: number;
}): NonNullable<CatalogModel["quantization"]> {
  const fileBase = args.primaryGgufFile.replace(/\.gguf$/, "");
  const mk = (
    id: CatalogQuantizationId,
    label: CatalogQuantizationVariant["label"],
    scale: number,
    minRamScale: number,
    status: CatalogQuantizationVariant["status"],
  ): CatalogQuantizationVariant => ({
    id,
    label,
    ggufFile:
      id === "q4_k_m" ? args.primaryGgufFile : `${fileBase}-${QUANT_SUFFIX[id]}.gguf`,
    sizeGb: Number((args.q4SizeGb * scale).toFixed(1)),
    minRamGb: Math.ceil(args.q4MinRamGb * minRamScale),
    status,
  });
  return {
    defaultVariantId: "q4_k_m",
    variants: [
      mk("q4_k_m", "4-bit", 1, 1, "published"),
      mk("q6_k", "6-bit", 1.45, 1.35, "planned"),
      mk("q8_0", "8-bit", 1.95, 1.8, "planned"),
    ],
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
    hfRepo: ELIZA_1_HF_REPO,
    hfPathPrefix: bundleRemotePrefix(args.id),
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
    id: "eliza-1-0_8b",
    displayName: "eliza-1-0_8b",
    hfRepo: "ggml-org/Qwen3.5-0.8B-Base-GGUF",
    ggufFile: "Qwen3.5-0.8B-Base-Q4_0.gguf",
    params: "0.8B",
    quant: "Qwen3.5 GGUF local runtime",
    sizeGb: 0.6,
    minRamGb: 2,
    category: "chat",
    bucket: "small",
    contextLength: 32768,
    tokenizerFamily: "qwen35",
    sourceModel: sourceModelForTier("eliza-1-0_8b"),
    voiceBackends: ELIZA_1_VOICE_BACKENDS["eliza-1-0_8b"],
    quantization: textQuantizationMatrix({
      primaryGgufFile: "Qwen3.5-0.8B-Base-Q4_0.gguf",
      q4SizeGb: 0.6,
      q4MinRamGb: 2,
    }),
    blurb:
      "eliza-1-0_8b - smallest Qwen3.5 local tier; runs on modern phones and simulator smoke targets.",
  },
  {
    id: "eliza-1-2b",
    displayName: "eliza-1-2b",
    hfRepo: ELIZA_1_HF_REPO,
    hfPathPrefix: bundleRemotePrefix("eliza-1-2b"),
    ggufFile: bundlePath("eliza-1-2b", "text/eliza-1-2b-32k.gguf"),
    bundleManifestFile: bundlePath("eliza-1-2b", "eliza-1.manifest.json"),
    params: "2B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 1.4,
    minRamGb: 4,
    category: "chat",
    bucket: "small",
    contextLength: 32768,
    tokenizerFamily: "qwen35",
    companionModelIds: ["eliza-1-2b-drafter"],
    sourceModel: sourceModelForTier("eliza-1-2b"),
    voiceBackends: ELIZA_1_VOICE_BACKENDS["eliza-1-2b"],
    runtime: runtimeFor("eliza-1-2b", 32768),
    quantization: textQuantizationMatrix({
      primaryGgufFile: bundlePath("eliza-1-2b", "text/eliza-1-2b-32k.gguf"),
      q4SizeGb: 1.4,
      q4MinRamGb: 4,
    }),
    blurb:
      "eliza-1-2b - first-run Qwen3.5 mid tier for modern phones and laptops.",
  },
  drafterCompanion({
    id: "eliza-1-2b",
    displayName: "eliza-1-2b",
    ggufFile: bundlePath("eliza-1-2b", "dflash/drafter-2b.gguf"),
    params: "0.8B",
    sizeGb: 0.4,
    minRamGb: 4,
    bucket: "small",
  }),
  {
    id: "eliza-1-4b",
    displayName: "eliza-1-4b",
    hfRepo: ELIZA_1_HF_REPO,
    hfPathPrefix: bundleRemotePrefix("eliza-1-4b"),
    ggufFile: bundlePath("eliza-1-4b", "text/eliza-1-4b-64k.gguf"),
    bundleManifestFile: bundlePath("eliza-1-4b", "eliza-1.manifest.json"),
    params: "4B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 2.7,
    minRamGb: 8,
    category: "chat",
    bucket: "mid",
    contextLength: 65536,
    tokenizerFamily: "qwen35",
    companionModelIds: ["eliza-1-4b-drafter"],
    hiddenFromCatalog: true,
    sourceModel: sourceModelForTier("eliza-1-4b"),
    voiceBackends: ELIZA_1_VOICE_BACKENDS["eliza-1-4b"],
    runtime: runtimeFor("eliza-1-4b", 65536),
    gpuProfile: "rtx-3090",
    quantization: textQuantizationMatrix({
      primaryGgufFile: bundlePath("eliza-1-4b", "text/eliza-1-4b-64k.gguf"),
      q4SizeGb: 2.7,
      q4MinRamGb: 8,
    }),
    blurb:
      "eliza-1-4b - hidden future Qwen3.5 tier pending final bundle publication.",
  },
  drafterCompanion({
    id: "eliza-1-4b",
    displayName: "eliza-1-4b",
    ggufFile: bundlePath("eliza-1-4b", "dflash/drafter-4b.gguf"),
    params: "0.8B",
    sizeGb: 0.5,
    minRamGb: 8,
    bucket: "mid",
  }),
  {
    id: "eliza-1-9b",
    displayName: "eliza-1-9b",
    hfRepo: ELIZA_1_HF_REPO,
    hfPathPrefix: bundleRemotePrefix("eliza-1-9b"),
    ggufFile: bundlePath("eliza-1-9b", "text/eliza-1-9b-64k.gguf"),
    bundleManifestFile: bundlePath("eliza-1-9b", "eliza-1.manifest.json"),
    params: "9B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 5.4,
    minRamGb: 12,
    category: "chat",
    bucket: "mid",
    contextLength: 65536,
    tokenizerFamily: "qwen35",
    companionModelIds: ["eliza-1-9b-drafter"],
    hiddenFromCatalog: true,
    sourceModel: sourceModelForTier("eliza-1-9b"),
    voiceBackends: ELIZA_1_VOICE_BACKENDS["eliza-1-9b"],
    runtime: runtimeFor("eliza-1-9b", 65536),
    gpuProfile: "rtx-3090",
    quantization: textQuantizationMatrix({
      primaryGgufFile: bundlePath("eliza-1-9b", "text/eliza-1-9b-64k.gguf"),
      q4SizeGb: 5.4,
      q4MinRamGb: 12,
    }),
    blurb:
      "eliza-1-9b - hidden large-tier placeholder pending final release approval.",
  },
  drafterCompanion({
    id: "eliza-1-9b",
    displayName: "eliza-1-9b",
    ggufFile: bundlePath("eliza-1-9b", "dflash/drafter-9b.gguf"),
    params: "1.7B",
    sizeGb: 1.2,
    minRamGb: 12,
    bucket: "mid",
  }),
  {
    id: "eliza-1-27b",
    displayName: "eliza-1-27b",
    hfRepo: ELIZA_1_HF_REPO,
    hfPathPrefix: bundleRemotePrefix("eliza-1-27b"),
    ggufFile: bundlePath("eliza-1-27b", "text/eliza-1-27b-128k.gguf"),
    bundleManifestFile: bundlePath("eliza-1-27b", "eliza-1.manifest.json"),
    params: "27B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 16.8,
    minRamGb: 32,
    category: "chat",
    bucket: "large",
    contextLength: 131072,
    tokenizerFamily: "qwen35",
    companionModelIds: ["eliza-1-27b-drafter"],
    hiddenFromCatalog: true,
    sourceModel: sourceModelForTier("eliza-1-27b"),
    voiceBackends: ELIZA_1_VOICE_BACKENDS["eliza-1-27b"],
    runtime: runtimeFor("eliza-1-27b", 131072),
    gpuProfile: "rtx-4090",
    quantization: textQuantizationMatrix({
      primaryGgufFile: bundlePath("eliza-1-27b", "text/eliza-1-27b-128k.gguf"),
      q4SizeGb: 16.8,
      q4MinRamGb: 32,
    }),
    blurb:
      "eliza-1-27b - hidden high-memory placeholder pending final release approval.",
  },
  drafterCompanion({
    id: "eliza-1-27b",
    displayName: "eliza-1-27b",
    ggufFile: bundlePath("eliza-1-27b", "dflash/drafter-27b.gguf"),
    params: "4B",
    sizeGb: 2.4,
    minRamGb: 32,
    bucket: "large",
  }),
  {
    id: "eliza-1-27b-256k",
    displayName: "eliza-1-27b-256k",
    hfRepo: ELIZA_1_HF_REPO,
    hfPathPrefix: bundleRemotePrefix("eliza-1-27b-256k"),
    ggufFile: bundlePath("eliza-1-27b-256k", "text/eliza-1-27b-256k.gguf"),
    bundleManifestFile: bundlePath("eliza-1-27b-256k", "eliza-1.manifest.json"),
    params: "27B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 16.8,
    minRamGb: 96,
    category: "chat",
    bucket: "large",
    contextLength: 262144,
    tokenizerFamily: "qwen35",
    companionModelIds: ["eliza-1-27b-256k-drafter"],
    hiddenFromCatalog: true,
    sourceModel: sourceModelForTier("eliza-1-27b-256k"),
    voiceBackends: ELIZA_1_VOICE_BACKENDS["eliza-1-27b-256k"],
    runtime: runtimeFor("eliza-1-27b-256k", 262144),
    gpuProfile: "rtx-5090",
    quantization: textQuantizationMatrix({
      primaryGgufFile: bundlePath(
        "eliza-1-27b-256k",
        "text/eliza-1-27b-256k.gguf",
      ),
      q4SizeGb: 16.8,
      q4MinRamGb: 96,
    }),
    blurb:
      "eliza-1-27b-256k - hidden workstation placeholder pending final release approval.",
  },
  drafterCompanion({
    id: "eliza-1-27b-256k",
    displayName: "eliza-1-27b-256k",
    ggufFile: bundlePath("eliza-1-27b-256k", "dflash/drafter-27b-256k.gguf"),
    params: "4B",
    sizeGb: 2.4,
    minRamGb: 96,
    bucket: "large",
  }),
  {
    id: "eliza-1-27b-1m",
    displayName: "eliza-1-27b-1m",
    hfRepo: ELIZA_1_HF_REPO,
    hfPathPrefix: bundleRemotePrefix("eliza-1-27b-1m"),
    ggufFile: bundlePath("eliza-1-27b-1m", "text/eliza-1-27b-1m.gguf"),
    bundleManifestFile: bundlePath("eliza-1-27b-1m", "eliza-1.manifest.json"),
    params: "27B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 16.8,
    minRamGb: 200,
    category: "chat",
    bucket: "large",
    contextLength: 1_048_576,
    tokenizerFamily: "qwen35",
    companionModelIds: ["eliza-1-27b-1m-drafter"],
    hiddenFromCatalog: true,
    sourceModel: sourceModelForTier("eliza-1-27b-1m"),
    voiceBackends: ELIZA_1_VOICE_BACKENDS["eliza-1-27b-1m"],
    runtime: runtimeFor("eliza-1-27b-1m", 1_048_576),
    gpuProfile: "h200",
    quantization: textQuantizationMatrix({
      primaryGgufFile: bundlePath("eliza-1-27b-1m", "text/eliza-1-27b-1m.gguf"),
      q4SizeGb: 16.8,
      q4MinRamGb: 200,
    }),
    blurb:
      "eliza-1-27b-1m - hidden GH200-class server placeholder with a 1M-token context window.",
  },
  drafterCompanion({
    id: "eliza-1-27b-1m",
    displayName: "eliza-1-27b-1m",
    ggufFile: bundlePath("eliza-1-27b-1m", "dflash/drafter-27b-1m.gguf"),
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
  const cleanFilePath = filePath.replace(/^\/+/, "");
  const cleanPrefix = model.hfPathPrefix?.replace(/^\/+|\/+$/g, "");
  const pathWithPrefix =
    cleanPrefix &&
    cleanFilePath !== cleanPrefix &&
    !cleanFilePath.startsWith(`${cleanPrefix}/`)
      ? `${cleanPrefix}/${cleanFilePath}`
      : cleanFilePath;
  if (model.hub === "modelscope") {
    const base =
      process.env.ELIZA_MODELSCOPE_BASE_URL?.trim().replace(/\/+$/, "") ||
      "https://www.modelscope.cn";
    const encodedPath = pathWithPrefix
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${base}/models/${model.hfRepo}/resolve/master/${encodedPath}`;
  }
  const base =
    process.env.ELIZA_HF_BASE_URL?.trim().replace(/\/+$/, "") ||
    "https://huggingface.co";
  const encodedPath = pathWithPrefix
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/${model.hfRepo}/resolve/main/${encodedPath}?download=true`;
}

export function buildHuggingFaceResolveUrl(model: CatalogModel): string {
  return buildHuggingFaceResolveUrlForPath(model, model.ggufFile);
}
