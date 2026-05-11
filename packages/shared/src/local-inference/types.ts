/**
 * Local inference shared types.
 *
 * Canonical source of truth for every type that the server-side service
 * in `@elizaos/app-core` and the UI client in `@elizaos/ui` reference.
 * Both packages re-export from here through one-line shims so existing
 * import paths keep working.
 *
 * Server-only logic (KV cache management, llama-server lifecycle,
 * conversation registry, metrics scraping) stays in `app-core`; only
 * the type contracts live here.
 */

/** Agent slot ids the runtime maps to a local model. */
export type AgentModelSlot = "TEXT_SMALL" | "TEXT_LARGE" | "TEXT_EMBEDDING";

/** Subset of `AgentModelSlot` that participates in text generation. */
export type TextGenerationSlot = Extract<
  AgentModelSlot,
  "TEXT_SMALL" | "TEXT_LARGE"
>;

export const AGENT_MODEL_SLOTS: AgentModelSlot[] = [
  "TEXT_SMALL",
  "TEXT_LARGE",
  "TEXT_EMBEDDING",
];

export const TEXT_GENERATION_SLOTS: TextGenerationSlot[] = [
  "TEXT_SMALL",
  "TEXT_LARGE",
];

/**
 * Mapping of agent slot → installed model id. Persisted to disk by
 * `assignments.ts` and consumed by both the runtime router and the UI
 * model picker.
 */
export type ModelAssignments = Partial<Record<AgentModelSlot, string>>;

/**
 * Installed-model registry entry. The on-disk format is JSON; this is the
 * canonical TypeScript shape both packages parse against.
 */
export interface InstalledModel {
  /** Matches CatalogModel.id when installed from the curated catalog. */
  id: string;
  displayName: string;
  /** Absolute path to the GGUF file on disk. */
  path: string;
  sizeBytes: number;
  /**
   * Eliza-1 bundle root when this installed model came from a multi-file
   * manifest. `path` still points at the primary GGUF used for loading the
   * model; sibling voice/cache/drafter files live under this root.
   */
  bundleRoot?: string;
  /** Absolute path to the validated `eliza-1.manifest.json`, when present. */
  manifestPath?: string;
  /** SHA256 of the validated manifest file, when present. */
  manifestSha256?: string;
  /** Semver bundle version from the manifest, when present. */
  bundleVersion?: string;
  /** Total bytes installed under `bundleRoot`, including voice/cache files. */
  bundleSizeBytes?: number;
  /** HF repo this came from, when known. */
  hfRepo?: string;
  /** ISO timestamp of install completion. */
  installedAt: string;
  /** ISO timestamp of last activation (null if never loaded). */
  lastUsedAt: string | null;
  /** Where we got this model from. Determines whether Eliza owns the file. */
  source: "eliza-download" | "external-scan";
  /**
   * When source === "external-scan", which tool the file belonged to.
   * Prevents Eliza from deleting files other apps own.
   */
  externalOrigin?:
    | "lm-studio"
    | "jan"
    | "ollama"
    | "huggingface"
    | "text-gen-webui";
  /** SHA256 of the GGUF file recorded at install time. Optional for legacy entries. */
  sha256?: string;
  /** ISO timestamp of the last successful re-verification. Absent = never verified since install. */
  lastVerifiedAt?: string;
  runtimeRole?: "chat" | "dflash-drafter";
  companionFor?: string;
}

export type ModelBucket = "small" | "mid" | "large" | "xl";

export type ModelCategory =
  | "chat"
  | "code"
  | "tools"
  | "tiny"
  | "reasoning"
  | "drafter";

export type LocalRuntimeBackend = "node-llama-cpp" | "llama-server";

/**
 * Specialised llama.cpp kernels shipped by the buun-llama-cpp / DFlash fork.
 * Models that declare a `requiresKernel` advertise that they only run
 * correctly under llama-server when the matching kernel is present.
 *
 * The set must stay in sync with `inference/AGENTS.md` §3 mandatory
 * optimizations and with `DflashBinaryCapabilities.kernels` below — the
 * capability probe is the runtime gate that refuses to start if a required
 * kernel is missing.
 */
export type LocalRuntimeKernel =
  | "dflash"
  | "turbo3"
  | "turbo4"
  | "turbo3_tcq"
  | "qjl_full"
  | "polarquant";

/**
 * llama.cpp optimization knobs that the dispatcher can wire into a
 * `llama-server` spawn. Values come from catalog metadata (per-model) and
 * environment overrides (per-process). The catalog is the source of truth
 * for which knobs are *safe* on a given quant; env vars are the operator's
 * escape hatch and override the catalog when set.
 */
export interface LocalRuntimeOptimizations {
  /** Lookahead decoding window. Maps to `--lookahead N` on llama-server. */
  lookahead?: number;
  /**
   * Built-in n-gram drafter (no separate drafter model). Maps to
   * `--draft-min` / `--draft-max` / `--draft-min-prob`. Mutually exclusive
   * with DFlash speculative decoding.
   */
  ngramDraft?: { min: number; max: number; minProb: number };
  /**
   * `--parallel N` for continuous batching. The Cache Bridge agent may bump
   * this default at runtime; the dispatcher reads but does not override.
   */
  parallel?: number;
  /**
   * llama-server prompt-cache chunk reuse threshold. Maps to
   * `--cache-reuse N`; useful for repeated tool/system prefixes where a
   * full slot restore is not available.
   */
  cacheReuse?: number;
  /**
   * llama-server RAM budget for prompt/KV cache files. Maps to
   * `--cache-ram N` in MiB.
   */
  cacheRamMb?: number;
  /** `--batch-size N` logical batch size. */
  batchSize?: number;
  /** `--ubatch-size N` physical micro-batch size. */
  ubatchSize?: number;
  /** Continuous batching toggle (`--cont-batching` / `--no-cont-batching`). */
  contBatching?: boolean;
  /** Unified KV cache toggle (`--kv-unified` / `--no-kv-unified`). */
  kvUnified?: boolean;
  /** Host tensor op offload toggle (`--op-offload` / `--no-op-offload`). */
  opOffload?: boolean;
  /**
   * Mixture-of-experts expert-tensor offload target. `"cpu"` maps to
   * `-ot ".*=CPU"` so expert tensors stay in CPU memory and only the
   * shared layers occupy VRAM.
   */
  moeOffload?: "cpu" | "none";
  /** `--mlock` — pin model pages in RAM. */
  mlock?: boolean;
  /** Inverse of `--mmap`; maps to `--no-mmap`. */
  noMmap?: boolean;
  /** Multimodal projector path; maps to `--mmproj <path>`. */
  mmproj?: string;
  /** `--alias <name>` for the OpenAI-compatible model id. */
  alias?: string;
  /** `-fa on` (flash attention). Always on for DFlash. */
  flashAttention?: boolean;
  /**
   * Specialised kernels this model requires from the llama-server fork.
   * The dispatcher uses this to pick `llama-server` over `node-llama-cpp`
   * regardless of `preferredBackend`, since the in-process binding cannot
   * provide these kernels.
   */
  requiresKernel?: LocalRuntimeKernel[];
}

export interface LocalRuntimeAcceleration {
  /**
   * Prefer out-of-process llama-server over the node binding when the
   * required binary and companion files are available.
   */
  preferredBackend?: LocalRuntimeBackend;
  /** Optimization knobs declared per-model. See `LocalRuntimeOptimizations`. */
  optimizations?: LocalRuntimeOptimizations;
  dflash?: {
    /** Catalog id of the hidden drafter GGUF companion. */
    drafterModelId: string;
    specType: "dflash";
    /** llama-server context for the target model. */
    contextSize: number;
    /** llama-server context for the drafter. */
    draftContextSize: number;
    /** Default draft range passed to llama-server. */
    draftMin: number;
    draftMax: number;
    /** `--n-gpu-layers` and `--n-gpu-layers-draft` defaults. */
    gpuLayers: number | "auto";
    draftGpuLayers: number | "auto";
    /** Some DFlash drafters are trained against non-thinking text. */
    disableThinking: boolean;
  };
  kvCache?: {
    /**
     * llama.cpp KV cache type overrides. Stock builds support f16/q8_0;
     * TurboQuant-capable forks add tbq3_0/tbq4_0.
     */
    typeK?: string;
    typeV?: string;
    requiresFork?: "apothic-turboquant" | "buun-llama-cpp";
  };
}

/**
 * Tokenizer family identifier used to verify that a DFlash target and its
 * paired drafter share a vocabulary. Speculative decoding requires the
 * target and drafter to emit token ids drawn from the same vocabulary —
 * see `docs/porting/dflash-drafter-strategy.md` for why mismatched
 * tokenizers cannot be bridged by metadata repair. Add new families here
 * as the catalog grows.
 */
export type TokenizerFamily = "eliza1" | "sentencepiece" | (string & {});

export interface CatalogModel {
  /** Stable Eliza id — used as the primary key. */
  id: string;
  displayName: string;
  /** HuggingFace repo slug, e.g. "elizaos/eliza-1-1_7b". */
  hfRepo: string;
  /** Exact GGUF filename in the repo. */
  ggufFile: string;
  /**
   * Optional Eliza-1 bundle manifest in the same HF repo. When present, the
   * downloader installs every file listed in the manifest and uses
   * `ggufFile` as the primary text GGUF inside that bundle.
   */
  bundleManifestFile?: string;
  params:
    | "360M"
    | "0.6B"
    | "1B"
    | "1.7B"
    | "2B"
    | "3B"
    | "4B"
    | "7B"
    | "8B"
    | "9B"
    | "14B"
    | "16B"
    | "22B"
    | "24B"
    | "27B"
    | "32B";
  quant: string;
  sizeGb: number;
  /** Minimum system RAM (GB) we recommend before offering this model. */
  minRamGb: number;
  category: ModelCategory;
  bucket: ModelBucket;
  blurb: string;
  /**
   * Hidden entries are installable by id and can be downloaded as companions,
   * but are omitted from the visible Model Hub catalog.
   */
  hiddenFromCatalog?: boolean;
  /** Models such as DFlash drafters are not valid standalone chat choices. */
  runtimeRole?: "chat" | "dflash-drafter";
  /** Parent chat model id when this entry is a hidden companion. */
  companionForModelId?: string;
  /** Extra catalog model ids to download alongside this model. */
  companionModelIds?: string[];
  /** Maximum context length supported by the underlying GGUF, in tokens. */
  contextLength?: number;
  /** Default GPU offload strategy for this model. */
  gpuLayers?: "auto" | number;
  /**
   * Tokenizer/vocabulary family this GGUF emits. Required for any entry
   * that participates in DFlash pairing.
   */
  tokenizerFamily?: TokenizerFamily;
  /** Runtime-specific acceleration metadata. */
  runtime?: LocalRuntimeAcceleration;
}

export type HardwareFitLevel = "fits" | "tight" | "wontfit";

export interface MobileHardwareProbe {
  platform: "ios" | "android" | "web";
  deviceModel?: string;
  machineId?: string;
  osVersion?: string;
  isSimulator?: boolean;
  availableRamGb?: number | null;
  freeStorageGb?: number | null;
  lowPowerMode?: boolean;
  thermalState?: "nominal" | "fair" | "serious" | "critical" | "unknown";
  gpuSupported?: boolean;
  dflashSupported?: boolean;
  dflashReason?: string;
  source?: "native" | "adapter-fallback";
}

export interface HardwareProbe {
  totalRamGb: number;
  freeRamGb: number;
  /** Null when no supported GPU is available (CPU-only). */
  gpu: {
    backend: "cuda" | "metal" | "vulkan";
    totalVramGb: number;
    freeVramGb: number;
  } | null;
  cpuCores: number;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  /** True on Apple Silicon (shared memory — large models are viable on 16GB+). */
  appleSilicon: boolean;
  /** Recommended default bucket based on available memory. */
  recommendedBucket: ModelBucket;
  /** Source of the probe; "node-llama-cpp" when GPU values come from the binding. */
  source: "node-llama-cpp" | "os-fallback";
  /** Mobile-only details used for minspec, storage, and native DFlash gating. */
  mobile?: MobileHardwareProbe;
}

export type DownloadState =
  | "queued"
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled";

export interface DownloadJob {
  jobId: string;
  modelId: string;
  state: DownloadState;
  /** Bytes transferred so far. */
  received: number;
  /** Total bytes expected (from Content-Length or HEAD). */
  total: number;
  /** Moving-average bytes/sec over the last few seconds. */
  bytesPerSec: number;
  /** Milliseconds remaining based on current rate. Null when unknown. */
  etaMs: number | null;
  startedAt: string;
  updatedAt: string;
  /** Set when state === "failed". */
  error?: string;
}

export interface LocalInferenceDownloadStatus {
  state: DownloadState | "missing";
  receivedBytes: number;
  totalBytes: number;
  percent: number | null;
  bytesPerSec: number;
  etaMs: number | null;
  updatedAt: string | null;
  errors: string[];
}

export interface ActiveModelState {
  modelId: string | null;
  loadedAt: string | null;
  /**
   * Human-readable load status. "idle" means nothing loaded.
   * "loading" is set while we're swapping models.
   */
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  /**
   * Effective KV-cache configuration the loader applied. Populated on
   * `status === "ready"`; null while loading or on error. The benchmark
   * harness relies on these to verify per-load overrides actually took
   * effect (a 128k contextSize request that silently fell back to 8k is
   * exactly the bug the per-load override path exists to prevent).
   */
  loadedContextSize?: number | null;
  loadedCacheTypeK?: string | null;
  loadedCacheTypeV?: string | null;
  loadedGpuLayers?: number | null;
}

export interface DownloadEvent {
  type: "progress" | "completed" | "failed" | "cancelled";
  job: DownloadJob;
}

export interface LocalInferenceSlotReadiness {
  slot: TextGenerationSlot;
  assigned: boolean;
  assignedModelId: string | null;
  displayName: string | null;
  primaryDownloaded: boolean;
  downloaded: boolean;
  active: boolean;
  ready: boolean;
  state:
    | "unassigned"
    | "missing"
    | "downloading"
    | "downloaded"
    | "active"
    | "failed"
    | "cancelled";
  requiredModelIds: string[];
  missingModelIds: string[];
  installedBytes: number;
  expectedBytes: number;
  download: LocalInferenceDownloadStatus;
  errors: string[];
}

export interface LocalInferenceReadiness {
  updatedAt: string;
  slots: Record<TextGenerationSlot, LocalInferenceSlotReadiness>;
}

export interface ModelHubSnapshot {
  catalog: CatalogModel[];
  installed: InstalledModel[];
  active: ActiveModelState;
  downloads: DownloadJob[];
  hardware: HardwareProbe;
  assignments: ModelAssignments;
  textReadiness: LocalInferenceReadiness;
}
