/**
 * Eliza-curated local model catalog.
 *
 * Default local inference is Eliza-1 only. External Hub search remains
 * custom/opt-in and never enters first-run or default eligibility.
 */

import type {
  CatalogModel,
  CatalogQuantizationId,
  CatalogQuantizationVariant,
  LocalRuntimeKernel,
} from "./types.js";

export const ELIZA_1_HF_REPO = "elizalabs/eliza-1" as const;

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

export const ELIZA_1_RELEASE_TIER_IDS =
  ELIZA_1_TIER_IDS satisfies ReadonlyArray<Eliza1TierId>;

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
  "eliza-1-0_8b": ["omnivoice", "kokoro"],
  "eliza-1-2b": ["omnivoice", "kokoro"],
  "eliza-1-4b": ["omnivoice", "kokoro"],
  "eliza-1-9b": ["omnivoice"],
  "eliza-1-27b": ["omnivoice"],
  "eliza-1-27b-256k": ["omnivoice"],
  "eliza-1-27b-1m": ["omnivoice"],
};

export const KOKORO_SOURCE_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";

const BASE_REQUIRED_KERNELS: LocalRuntimeKernel[] = [
  "dflash",
  "turbo3",
  "turbo4",
  "qjl_full",
  "polarquant",
];

interface TierSpec {
  id: Eliza1TierId;
  params: CatalogModel["params"];
  sizeGb: number;
  minRamGb: number;
  bucket: CatalogModel["bucket"];
  contextLength: number;
  textFile: string;
  q4MinRamGb: number;
  drafterParams: CatalogModel["params"];
  drafterSizeGb: number;
  drafterMinRamGb: number;
  gpuProfile?: string;
  hasEmbedding?: boolean;
  hasVision?: boolean;
}

const TIER_SPECS: Readonly<Record<Eliza1TierId, TierSpec>> = {
  "eliza-1-0_8b": {
    id: "eliza-1-0_8b",
    params: "0.6B",
    sizeGb: 0.6,
    minRamGb: 2,
    q4MinRamGb: 2,
    bucket: "small",
    contextLength: 32768,
    textFile: "text/eliza-1-0_8b-32k.gguf",
    drafterParams: "0.6B",
    drafterSizeGb: 0.3,
    drafterMinRamGb: 2,
  },
  "eliza-1-2b": {
    id: "eliza-1-2b",
    params: "1.7B",
    sizeGb: 1.4,
    minRamGb: 4,
    q4MinRamGb: 4,
    bucket: "small",
    contextLength: 32768,
    textFile: "text/eliza-1-2b-32k.gguf",
    drafterParams: "0.6B",
    drafterSizeGb: 0.5,
    drafterMinRamGb: 4,
    hasEmbedding: true,
  },
  "eliza-1-4b": {
    id: "eliza-1-4b",
    params: "4B",
    sizeGb: 3.0,
    minRamGb: 8,
    q4MinRamGb: 8,
    bucket: "mid",
    contextLength: 65536,
    textFile: "text/eliza-1-4b-64k.gguf",
    drafterParams: "1.7B",
    drafterSizeGb: 1.4,
    drafterMinRamGb: 8,
    hasEmbedding: true,
    hasVision: true,
  },
  "eliza-1-9b": {
    id: "eliza-1-9b",
    params: "9B",
    sizeGb: 6.4,
    minRamGb: 12,
    q4MinRamGb: 12,
    bucket: "large",
    contextLength: 65536,
    textFile: "text/eliza-1-9b-64k.gguf",
    drafterParams: "1.7B",
    drafterSizeGb: 1.4,
    drafterMinRamGb: 12,
    gpuProfile: "rtx-3090",
    hasEmbedding: true,
    hasVision: true,
  },
  "eliza-1-27b": {
    id: "eliza-1-27b",
    params: "27B",
    sizeGb: 16.8,
    minRamGb: 32,
    q4MinRamGb: 32,
    bucket: "xl",
    contextLength: 131072,
    textFile: "text/eliza-1-27b-128k.gguf",
    drafterParams: "4B",
    drafterSizeGb: 3.0,
    drafterMinRamGb: 32,
    gpuProfile: "rtx-4090",
    hasEmbedding: true,
    hasVision: true,
  },
  "eliza-1-27b-256k": {
    id: "eliza-1-27b-256k",
    params: "27B",
    sizeGb: 16.8,
    minRamGb: 96,
    q4MinRamGb: 96,
    bucket: "xl",
    contextLength: 262144,
    textFile: "text/eliza-1-27b-256k.gguf",
    drafterParams: "4B",
    drafterSizeGb: 3.0,
    drafterMinRamGb: 96,
    gpuProfile: "rtx-5090",
    hasEmbedding: true,
    hasVision: true,
  },
  "eliza-1-27b-1m": {
    id: "eliza-1-27b-1m",
    params: "27B",
    sizeGb: 16.8,
    minRamGb: 200,
    q4MinRamGb: 200,
    bucket: "xl",
    contextLength: 1_048_576,
    textFile: "text/eliza-1-27b-1m.gguf",
    drafterParams: "4B",
    drafterSizeGb: 3.0,
    drafterMinRamGb: 200,
    gpuProfile: "h200",
    hasEmbedding: true,
  },
};

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

function bundleComponent(
  id: Eliza1TierId,
  file: string,
): { repo: string; file: string } {
  return {
    repo: ELIZA_1_HF_REPO,
    file: bundleRemotePath(id, file),
  };
}

function sourceModelForTier(id: Eliza1TierId): CatalogModel["sourceModel"] {
  const spec = TIER_SPECS[id];
  const components: SourceComponentMap = {
    text: bundleComponent(id, spec.textFile),
    voice: bundleComponent(id, "tts/omnivoice-base-Q4_K_M.gguf"),
    asr: bundleComponent(id, "asr/eliza-1-asr.gguf"),
    vad: bundleComponent(id, "vad/eliza-1-vad.ggml.bin"),
    drafter: bundleComponent(id, `dflash/drafter-${tierSlug(id)}.gguf`),
  };

  if (spec.hasEmbedding) {
    components.embedding = bundleComponent(
      id,
      "embedding/eliza-1-embedding.gguf",
    );
  }
  if (spec.hasVision) {
    components.vision = bundleComponent(
      id,
      `vision/mmproj-${tierSlug(id)}.gguf`,
    );
  }

  return { finetuned: false, components };
}

function runtimeForTier(
  id: Eliza1TierId,
  contextLength: number,
): CatalogModel["runtime"] {
  const requiresKernel =
    contextLength >= 65536
      ? [...BASE_REQUIRED_KERNELS, "turbo3_tcq" as const]
      : BASE_REQUIRED_KERNELS;
  return {
    preferredBackend: "llama-server",
    optimizations: {
      parallel: 4,
      flashAttention: true,
      requiresKernel,
      ctxCheckpoints: 4,
      ctxCheckpointInterval: 4096,
    },
    kvCache: {
      typeK: "qjl1_256",
      typeV: "q4_polar",
      requiresFork: "buun-llama-cpp",
    },
    dflash: {
      drafterModelId: drafterId(id),
      specType: "dflash",
      contextSize: contextLength,
      draftContextSize: Math.min(contextLength, 65536),
      draftMin: 2,
      draftMax: contextLength >= 65536 ? 6 : 4,
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

function blurbForTier(id: Eliza1TierId): string {
  switch (id) {
    case "eliza-1-0_8b":
      return "eliza-1-0_8b - smallest local tier for low-memory phones and CPU fallback.";
    case "eliza-1-2b":
      return "eliza-1-2b - recommended first-run local tier for responsive text and voice.";
    case "eliza-1-4b":
      return "eliza-1-4b - compact multimodal local tier for voice, text, embeddings, and image input.";
    case "eliza-1-9b":
      return "eliza-1-9b - workstation local tier with stronger reasoning and multimodal input.";
    case "eliza-1-27b":
      return "eliza-1-27b - high-quality local tier for large-memory desktops and servers.";
    case "eliza-1-27b-256k":
      return "eliza-1-27b-256k - extended-context local tier for large-memory workstations.";
    case "eliza-1-27b-1m":
      return "eliza-1-27b-1m - maximum-context local tier for dedicated accelerator hosts.";
  }
}

function chatTier(id: Eliza1TierId): CatalogModel {
  const spec = TIER_SPECS[id];
  return {
    id,
    displayName: id,
    hfRepo: ELIZA_1_HF_REPO,
    hfPathPrefix: bundleRemotePrefix(id),
    ggufFile: bundlePath(id, spec.textFile),
    bundleManifestFile: bundlePath(id, "eliza-1.manifest.json"),
    params: spec.params,
    quant: "Eliza-1 optimized local runtime",
    sizeGb: spec.sizeGb,
    minRamGb: spec.minRamGb,
    category: "chat",
    bucket: spec.bucket,
    contextLength: spec.contextLength,
    tokenizerFamily: "qwen35",
    companionModelIds: [drafterId(id)],
    sourceModel: sourceModelForTier(id),
    voiceBackends: ELIZA_1_VOICE_BACKENDS[id],
    runtime: runtimeForTier(id, spec.contextLength),
    gpuProfile: spec.gpuProfile,
    quantization: textQuantizationMatrix({
      primaryGgufFile: bundlePath(id, spec.textFile),
      q4SizeGb: spec.sizeGb,
      q4MinRamGb: spec.q4MinRamGb,
    }),
    blurb: blurbForTier(id),
  };
}

function drafterCompanion(id: Eliza1TierId): CatalogModel {
  const spec = TIER_SPECS[id];
  return {
    id: drafterId(id),
    displayName: `${id} drafter`,
    hfRepo: ELIZA_1_HF_REPO,
    hfPathPrefix: bundleRemotePrefix(id),
    ggufFile: bundlePath(id, `dflash/drafter-${tierSlug(id)}.gguf`),
    params: spec.drafterParams,
    quant: "Eliza-1 drafter companion",
    sizeGb: spec.drafterSizeGb,
    minRamGb: spec.drafterMinRamGb,
    category: "drafter",
    bucket: spec.bucket,
    hiddenFromCatalog: true,
    runtimeRole: "dflash-drafter",
    companionForModelId: id,
    tokenizerFamily: "qwen35",
    blurb: "Companion drafter file.",
  };
}

export const MODEL_CATALOG: CatalogModel[] = ELIZA_1_TIER_IDS.flatMap((id) => [
  chatTier(id),
  drafterCompanion(id),
]);

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
