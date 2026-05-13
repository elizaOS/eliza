/**
 * Eliza-curated local model catalog.
 *
 * Eliza-1 is the only default-eligible model line. The user-facing model
 * ids are size-first (`eliza-1-0_6b`, `eliza-1-1_7b`, `eliza-1-4b`,
 * `eliza-1-9b`,
 * `eliza-1-27b`, `eliza-1-27b-256k`, `eliza-1-27b-1m`). The
 * recommendation engine picks one of these tiers based on hardware. The
 * long-context 27B variants (`27b-256k`, `27b-1m`) only surface on hosts
 * whose RAM/VRAM can hold the KV cache at that window — `27b-1m` is
 * GH200-class.
 *
 * Per the 2026-05-12 operator directive, the line is Qwen3.5-only:
 * `eliza-1-0_6b` (Qwen3.5-0.6B-Base), `eliza-1-1_7b` (Qwen3.5-1.7B-Base), and
 * `eliza-1-4b` (Qwen3.5-4B) are the active visible local tiers. Retired Qwen3
 * small-tier ids (`eliza-1-0_6b`, `eliza-1-1_7b`) are intentionally absent
 * from this catalog; the Qwen3 dense bases do not work with the Eliza-1
 * DFlash spec-decode path.
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
 * `tokenizerFamily: "qwen35"`. They are all Qwen3.5-lineage; within a tier the
 * text model and its drafter share the same 248320-token BPE vocabulary +
 * merges table. The drafter GGUFs ship *without* their
 * own `tokenizer.ggml.merges`; the runtime injects it from the tier's text
 * GGUF at load time (`resolveDflashDrafter` in
 * `packages/app-core/src/services/local-inference/dflash-server.ts`). The same
 * vocab also covers the bundled Qwen3-ASR text decoder and the bundled
 * Qwen3-Embedding model (1.7B+ tiers) — that is what gives zero re-tokenization
 * between ASR output and text input. The shared *vocabulary* does NOT mean a
 * shared *token-embedding tensor* (each GGUF has its own `token_embd.weight`),
 * and "shared mmap region for weights" in inference/AGENTS.md §4 is per-file
 * dedup — only text+vision share one GGUF/region today; the OmniVoice text
 * decoder, ASR, embedding, and drafter are separate files. Deduplicating the
 * vocab tensor itself would need a fused-architecture container, which is out
 * of scope per inference/AGENTS.md §2. Full analysis:
 * `packages/inference/reports/porting/2026-05-11/qwen-backbone-unification.md`.
 */

import type {
  CatalogModel,
  CatalogQuantizationId,
  CatalogQuantizationVariant,
  LocalRuntimeKernel,
} from "./types.js";

export const ELIZA_1_HF_REPO = "elizaos/eliza-1" as const;

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

export const ELIZA_1_RELEASE_TIER_IDS = [
  "eliza-1-0_6b",
  "eliza-1-1_7b",
  "eliza-1-4b",
] as const satisfies ReadonlyArray<Eliza1TierId>;

/**
 * The model id the engine auto-loads on first run when no preference is
 * set. Resolves to `eliza-1-1_7b`: the smallest mid-tier Qwen3.5 bundle with
 * enough headroom to be a good default on modern phones and laptops. The
 * ultra-small `0_6b` tier remains visible for low-RAM fallback.
 */
export const FIRST_RUN_DEFAULT_MODEL_ID: Eliza1TierId = "eliza-1-1_7b";

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

function bundlePath(id: Eliza1TierId, rel: string): string {
  void id;
  return rel;
}

function bundleRemotePath(id: Eliza1TierId, rel: string): string {
  return `${bundleRemotePrefix(id)}/${rel}`;
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
  "eliza-1-0_6b": ["kokoro"],
  "eliza-1-1_7b": ["kokoro"],
  "eliza-1-4b": ["kokoro"],
  // 9B straddles the product line: mobile/laptop installs can use Kokoro,
  // while workstation/server installs can use OmniVoice cloning.
  "eliza-1-9b": ["kokoro", "omnivoice"],
  "eliza-1-27b": ["omnivoice"],
  "eliza-1-27b-256k": ["omnivoice"],
  "eliza-1-27b-1m": ["omnivoice"],
};

/** Source repo for the Kokoro-82M ONNX export — same artifact across tiers. */
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
    file: bundleRemotePath(id, "asr/eliza-1-asr-small.gguf"),
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
    "eliza-1-0_6b": { repo: "Qwen/Qwen3.5-0.6B" },
    "eliza-1-1_7b": { repo: "Qwen/Qwen3.5-1.7B-Base" },
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
    "eliza-1-27b-1m": plannedVision,
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

const QUANT_SUFFIX: Record<CatalogQuantizationId, string> = {
  q4_k_m: "q4_k_m",
  q6_k: "q6_k",
  q8_0: "q8_0",
};

function textQuantizationMatrix(args: {
  id: Eliza1TierId;
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
  if (
    id === "eliza-1-0_6b" ||
    id === "eliza-1-1_7b"
  ) {
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
        id === "eliza-1-0_6b" ||
        id === "eliza-1-1_7b" ||
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
    id: "eliza-1-0_6b",
    displayName: "eliza-1-0_6b",
    hfRepo: ELIZA_1_HF_REPO,
    hfPathPrefix: bundleRemotePrefix("eliza-1-0_6b"),
    ggufFile: bundlePath("eliza-1-0_6b", "text/eliza-1-0_6b-32k.gguf"),
    bundleManifestFile: bundlePath("eliza-1-0_6b", "eliza-1.manifest.json"),
    params: "0.6B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 1.1,
    minRamGb: 2,
    category: "chat",
    bucket: "small",
    contextLength: 32768,
    tokenizerFamily: "qwen35",
    companionModelIds: ["eliza-1-0_6b-drafter"],
    sourceModel: sourceModelForTier("eliza-1-0_6b"),
    voiceBackends: ELIZA_1_VOICE_BACKENDS["eliza-1-0_6b"],
    runtime: runtimeFor("eliza-1-0_6b", 32768),
    quantization: textQuantizationMatrix({
      id: "eliza-1-0_6b",
      primaryGgufFile: bundlePath("eliza-1-0_6b", "text/eliza-1-0_6b-32k.gguf"),
      q4SizeGb: 1.1,
      q4MinRamGb: 2,
    }),
    blurb:
      "eliza-1-0_6b - smallest Qwen3.5 tier; runs on any modern phone or laptop with the optimized local runtime.",
  },
  drafterCompanion({
    id: "eliza-1-0_6b",
    displayName: "eliza-1-0_6b",
    ggufFile: bundlePath("eliza-1-0_6b", "dflash/drafter-0_6b.gguf"),
    params: "0.5B",
    sizeGb: 0.3,
    minRamGb: 2,
    bucket: "small",
  }),
  {
    id: "eliza-1-1_7b",
    displayName: "eliza-1-1_7b",
    hfRepo: ELIZA_1_HF_REPO,
    hfPathPrefix: bundleRemotePrefix("eliza-1-1_7b"),
    ggufFile: bundlePath("eliza-1-1_7b", "text/eliza-1-1_7b-32k.gguf"),
    bundleManifestFile: bundlePath("eliza-1-1_7b", "eliza-1.manifest.json"),
    params: "1.7B",
    quant: "Eliza-1 optimized local runtime",
    sizeGb: 1.4,
    minRamGb: 4,
    category: "chat",
    bucket: "small",
    contextLength: 32768,
    tokenizerFamily: "qwen35",
    companionModelIds: ["eliza-1-1_7b-drafter"],
    sourceModel: sourceModelForTier("eliza-1-1_7b"),
    voiceBackends: ELIZA_1_VOICE_BACKENDS["eliza-1-1_7b"],
    runtime: runtimeFor("eliza-1-1_7b", 32768),
    quantization: textQuantizationMatrix({
      id: "eliza-1-1_7b",
      primaryGgufFile: bundlePath("eliza-1-1_7b", "text/eliza-1-1_7b-32k.gguf"),
      q4SizeGb: 1.4,
      q4MinRamGb: 4,
    }),
    blurb:
      "eliza-1-1_7b - mid local tier on the Qwen3.5-1.7B-Base backbone; modern phones, mid laptops, the new default mid-Qwen3.5 fused-model line.",
  },
  drafterCompanion({
    id: "eliza-1-1_7b",
    displayName: "eliza-1-1_7b",
    ggufFile: bundlePath("eliza-1-1_7b", "dflash/drafter-1_7b.gguf"),
    params: "0.6B",
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
    sourceModel: sourceModelForTier("eliza-1-4b"),
    voiceBackends: ELIZA_1_VOICE_BACKENDS["eliza-1-4b"],
    runtime: runtimeFor("eliza-1-4b", 65536),
    quantization: textQuantizationMatrix({
      id: "eliza-1-4b",
      primaryGgufFile: bundlePath("eliza-1-4b", "text/eliza-1-4b-64k.gguf"),
      q4SizeGb: 2.7,
      q4MinRamGb: 8,
    }),
    blurb:
      "eliza-1-4b - mid-local tier on the Qwen3.5-4B backbone; mid laptop, 8+ GB phone, 64k context window.",
  },
  drafterCompanion({
    id: "eliza-1-4b",
    displayName: "eliza-1-4b",
    ggufFile: bundlePath("eliza-1-4b", "dflash/drafter-4b.gguf"),
    params: "0.6B",
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
      id: "eliza-1-9b",
      primaryGgufFile: bundlePath("eliza-1-9b", "text/eliza-1-9b-64k.gguf"),
      q4SizeGb: 5.4,
      q4MinRamGb: 12,
    }),
    blurb:
      "eliza-1-9b - future large-tier placeholder pending final Eliza-1 weights, evidence, and release approval.",
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
      id: "eliza-1-27b",
      primaryGgufFile: bundlePath("eliza-1-27b", "text/eliza-1-27b-128k.gguf"),
      q4SizeGb: 16.8,
      q4MinRamGb: 32,
    }),
    blurb:
      "eliza-1-27b - future high-memory placeholder pending final Eliza-1 weights, evidence, and release approval.",
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
      id: "eliza-1-27b-256k",
      primaryGgufFile: bundlePath(
        "eliza-1-27b-256k",
        "text/eliza-1-27b-256k.gguf",
      ),
      q4SizeGb: 16.8,
      q4MinRamGb: 96,
    }),
    blurb:
      "eliza-1-27b-256k - future workstation placeholder pending final Eliza-1 weights, evidence, and release approval.",
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
      id: "eliza-1-27b-1m",
      primaryGgufFile: bundlePath("eliza-1-27b-1m", "text/eliza-1-27b-1m.gguf"),
      q4SizeGb: 16.8,
      q4MinRamGb: 200,
    }),
    blurb:
      "eliza-1-27b-1m - H200-class server tier with a 1M-token context window and memory-optimized KV cache layout for 141 GiB HBM3e hosts.",
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
