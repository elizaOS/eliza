/**
 * Eliza-curated local model catalog.
 *
 * Active mobile/local release policy is intentionally narrow: Qwen3.5 0.8B
 * and Qwen3.5 2B only. Retired small-tier ids are not catalog entries,
 * recommendation candidates, or default-eligible fallbacks.
 */

import type {
  CatalogModel,
  CatalogQuantizationId,
  CatalogQuantizationVariant,
  LocalRuntimeKernel,
} from "./types.js";

export const ELIZA_1_HF_REPO = "elizaos/eliza-1" as const;

export const ELIZA_1_TIER_IDS = ["eliza-1-0_8b", "eliza-1-2b"] as const;

export type Eliza1TierId = (typeof ELIZA_1_TIER_IDS)[number];

export const ELIZA_1_RELEASE_TIER_IDS =
  ELIZA_1_TIER_IDS satisfies ReadonlyArray<Eliza1TierId>;

/** First-run default: the Qwen3.5 2B bundle. */
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

export type VoiceBackendId = "kokoro" | "omnivoice";

export const ELIZA_1_VOICE_BACKENDS: Record<
  Eliza1TierId,
  ReadonlyArray<VoiceBackendId>
> = {
  "eliza-1-0_8b": ["kokoro"],
  "eliza-1-2b": ["kokoro", "omnivoice"],
};

export const KOKORO_SOURCE_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";

const QWEN35_0_8B_GGUF_REPO = "ggml-org/Qwen3.5-0.8B-Base-GGUF";

const BASE_REQUIRED_KERNELS: LocalRuntimeKernel[] = [
  "dflash",
  "turbo4",
  "qjl_full",
  "polarquant",
];

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

function sourceModelForTier(id: Eliza1TierId): CatalogModel["sourceModel"] {
  const kokoro = { repo: KOKORO_SOURCE_REPO } as const;
  const omnivoice = { repo: "Serveurperso/OmniVoice-GGUF" } as const;
  const silero = { repo: "onnx-community/silero-vad" } as const;

  const components: SourceComponentMap = {
    text:
      id === "eliza-1-0_8b"
        ? { repo: "Qwen/Qwen3.5-0.8B" }
        : { repo: "Qwen/Qwen3.5-2B-Base" },
    voice: id === "eliza-1-0_8b" ? kokoro : omnivoice,
    asr: {
      repo: ELIZA_1_HF_REPO,
      file: bundleRemotePath(id, "asr/eliza-1-asr.gguf"),
    },
    vad: silero,
  };

  if (id === "eliza-1-2b") {
    components.embedding = {
      repo: ELIZA_1_HF_REPO,
      file: bundleRemotePath(id, "embedding/eliza-1-embedding.gguf"),
    };
    components.drafter = {
      repo: ELIZA_1_HF_REPO,
      file: bundleRemotePath(id, "dflash/drafter-2b.gguf"),
    };
  }

  return { finetuned: false, components };
}

function runtimeFor2b(contextLength: number): CatalogModel["runtime"] {
  return {
    preferredBackend: "llama-server",
    optimizations: {
      parallel: 4,
      flashAttention: true,
      requiresKernel: BASE_REQUIRED_KERNELS,
      ctxCheckpoints: 4,
      ctxCheckpointInterval: 4096,
    },
    kvCache: {
      typeK: "qjl1_256",
      typeV: "q4_polar",
      requiresFork: "buun-llama-cpp",
    },
    dflash: {
      drafterModelId: drafterId("eliza-1-2b"),
      specType: "dflash",
      contextSize: contextLength,
      draftContextSize: Math.min(contextLength, 65536),
      draftMin: 2,
      draftMax: 4,
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
      id === "q4_k_m"
        ? args.primaryGgufFile
        : `${fileBase}-${QUANT_SUFFIX[id]}.gguf`,
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
    hfRepo: QWEN35_0_8B_GGUF_REPO,
    ggufFile: "Qwen3.5-0.8B-Base-Q4_0.gguf",
    params: "0.8B",
    quant: "Q4_0 GGUF",
    sizeGb: 0.5,
    minRamGb: 2,
    category: "chat",
    bucket: "small",
    contextLength: 32768,
    tokenizerFamily: "qwen35",
    sourceModel: sourceModelForTier("eliza-1-0_8b"),
    voiceBackends: ELIZA_1_VOICE_BACKENDS["eliza-1-0_8b"],
    blurb:
      "eliza-1-0_8b - smallest Qwen3.5 local tier for simulator smoke, low-RAM phones, and CPU fallback.",
  },
  {
    id: "eliza-1-2b",
    displayName: "eliza-1-2b",
    hfRepo: ELIZA_1_HF_REPO,
    hfPathPrefix: bundleRemotePrefix("eliza-1-2b"),
    ggufFile: bundlePath("eliza-1-2b", "text/eliza-1-2b-32k.gguf"),
    bundleManifestFile: bundlePath("eliza-1-2b", "eliza-1.manifest.json"),
    params: "2B",
    quant: "Eliza-1 optimized Qwen3.5 local runtime",
    sizeGb: 1.4,
    minRamGb: 4,
    category: "chat",
    bucket: "small",
    contextLength: 32768,
    tokenizerFamily: "qwen35",
    companionModelIds: ["eliza-1-2b-drafter"],
    sourceModel: sourceModelForTier("eliza-1-2b"),
    voiceBackends: ELIZA_1_VOICE_BACKENDS["eliza-1-2b"],
    runtime: runtimeFor2b(32768),
    quantization: textQuantizationMatrix({
      primaryGgufFile: bundlePath("eliza-1-2b", "text/eliza-1-2b-32k.gguf"),
      q4SizeGb: 1.4,
      q4MinRamGb: 4,
    }),
    blurb:
      "eliza-1-2b - first-run Qwen3.5 local tier with text and voice prepared for the optimized local runtime.",
  },
  drafterCompanion({
    id: "eliza-1-2b",
    displayName: "eliza-1-2b",
    ggufFile: bundlePath("eliza-1-2b", "dflash/drafter-2b.gguf"),
    params: "0.8B",
    sizeGb: 0.5,
    minRamGb: 4,
    bucket: "small",
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
