/**
 * Local inference shared types.
 *
 * Shared contracts referenced by the server-side service in
 * `@elizaos/app-core` and the UI client in `@elizaos/ui`.
 *
 * Server-only logic (KV cache management, native runtime lifecycle,
 * conversation registry, metrics scraping) stays in `app-core`; only
 * the type contracts live here.
 */

/** Agent slot ids the runtime maps to a local model. */
export type AgentModelSlot =
  | "TEXT_SMALL"
  | "TEXT_LARGE"
  | "TEXT_EMBEDDING"
  | "TEXT_TO_SPEECH"
  | "TRANSCRIPTION";

/** Subset of `AgentModelSlot` that participates in text generation. */
export type TextGenerationSlot = Extract<
  AgentModelSlot,
  "TEXT_SMALL" | "TEXT_LARGE"
>;

export const AGENT_MODEL_SLOTS: AgentModelSlot[] = [
  "TEXT_SMALL",
  "TEXT_LARGE",
  "TEXT_EMBEDDING",
  "TEXT_TO_SPEECH",
  "TRANSCRIPTION",
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
 * Installed-model registry entry. The on-disk format is JSON.
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
   * model; sibling voice/cache files live under this root.
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
  /**
   * ISO timestamp of the one-time on-device verify pass for an Eliza-1
   * bundle (load → 1-token text gen → 1-phrase voice gen → barge-in cancel,
   * per `packages/inference/AGENTS.md` §7). Absent = the bundle was
   * materialized but the verify-on-device pass has not run; such a bundle
   * must not be auto-selected as the recommended default.
   */
  bundleVerifiedAt?: string;
  runtimeRole?: "chat" | "dflash-drafter";
  companionFor?: string;
}

export type ModelBucket = "small" | "mid" | "large" | "xl";

export type ModelCategory =
  | "chat"
  | "code"
  | "tools"
  | "tiny"
  | "reasoning";

export type LocalRuntimeBackend = "capacitor-llama" | "llama-cpp";

export type OpenVinoDeviceKind = "CPU" | "GPU" | "NPU";

export interface OpenVinoHardwareProbe {
  /**
   * True when an OpenVINO runtime install is discoverable from env vars or
   * common Linux install paths. CPU execution still requires this runtime.
   */
  runtimeAvailable: boolean;
  devices: OpenVinoDeviceKind[];
  /**
   * Intel GPU plugin candidates. On Linux these are `/dev/dri/renderD*`
   * render nodes plus the Intel Compute Runtime userspace libraries.
   */
  gpu: {
    renderNodes: string[];
    computeRuntimeReady: boolean;
    missingLinuxPackages: string[];
  };
  /**
   * Intel NPU plugin candidates. On Linux these are `/dev/accel/accel*`
   * nodes; their presence only means the device is wireable, not validated.
   */
  npu: {
    accelNodes: string[];
  };
  /** Best-known OpenVINO device for static-graph ASR workloads. */
  recommendedAsrDevice: OpenVinoDeviceKind | null;
  warnings: string[];
}

/**
 * Runtime kernel/capability handles advertised by the optimized llama.cpp
 * runtime. Most entries are specialised kernels shipped by the
 * buun-llama-cpp fork. `openvino` is the upstream ggml-openvino
 * backend capability; it selects CPU/GPU/NPU at runtime via
 * `GGML_OPENVINO_DEVICE` and does not satisfy the Eliza-1 W4-B kernel set.
 *
 * Models that declare a `requiresKernel` advertise that they only run
 * correctly under optimized llama.cpp when the matching capability is present.
 *
 * The set must stay in sync with `inference/AGENTS.md` §3 mandatory
 * optimizations and with the native runtime capability probe — the
 * capability probe is the runtime gate that refuses to start if a required
 * kernel is missing.
 *
 * This (the llama.cpp-handle layer) is *not* the same enum as the
 * bundle-manifest layer's `Eliza1Kernel`
 * (`@elizaos/app-core/src/services/local-inference/manifest/schema`):
 * `turboquant_q3↔turbo3`, `turboquant_q4↔turbo4`, `qjl↔qjl_full`, with
 * `polarquant` / `turbo3_tcq` shared by name. The translation is
 * codified there by `ELIZA1_TO_RUNTIME_KERNEL` / `RUNTIME_TO_ELIZA1_KERNEL`.
 * `openvino` intentionally has no manifest-level Eliza-1 kernel equivalent.
 */
export type LocalRuntimeKernel =
  | "turbo3"
  | "turbo4"
  | "turbo3_tcq"
  | "qjl_full"
  | "polarquant"
  | "dflash"
  | "openvino";

/**
 * llama.cpp optimization knobs that the dispatcher can wire into the
 * FFI runtime. Values come from catalog metadata (per-model) and
 * environment overrides (per-process). The catalog is the source of truth
 * for which knobs are *safe* on a given quant; env vars are the operator's
 * escape hatch and override the catalog when set.
 */
export interface LocalRuntimeOptimizations {
  /** Lookahead decoding window. */
  lookahead?: number;
  /**
   * Built-in n-gram drafter (no separate drafter model). Maps to
   * Built-in n-gram speculation. `minProb` is kept for older configs and
   * ignored by current llama.cpp ngram-mod.
   */
  ngramDraft?: { min: number; max: number; minProb: number };
  /**
   * `--parallel N` for continuous batching. The Cache Bridge agent may bump
   * this default at runtime; the dispatcher reads but does not override.
   */
  parallel?: number;
  /**
   * Prompt-cache chunk reuse threshold. Useful for repeated tool/system prefixes where a
   * full slot restore is not available.
   */
  cacheReuse?: number;
  /**
   * RAM budget for prompt/KV cache files, in MiB.
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
  /**
   * Number of runtime context checkpoints the cache bridge should keep for
   * interruption/resume.
   */
  ctxCheckpoints?: number;
  /** Token interval between saved context checkpoints. */
  ctxCheckpointInterval?: number;
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
  /** Flash attention. */
  flashAttention?: boolean;
  /** Use native DFlash verifier events when the runtime advertises support. */
  nativeDflashEvents?: boolean;
  /**
   * Specialised kernels this model requires from optimized llama.cpp.
   * The dispatcher uses this to pick `llama-cpp` over `capacitor-llama`
   * regardless of `preferredBackend`, since the legacy node binding cannot
   * provide these kernels.
   */
  requiresKernel?: LocalRuntimeKernel[];
  /**
   * Kernels that must be disabled for this model. Used when a fused build
   * co-compiles a backend (e.g. OpenVINO) that this model is known not to
   * support.
   */
  unsupportedKernels?: LocalRuntimeKernel[];
}

export interface LocalRuntimeAcceleration {
  /**
   * Prefer the optimized llama.cpp path over the node binding when the
   * required runtime is available.
   */
  preferredBackend?: LocalRuntimeBackend;
  /** Optimization knobs declared per-model. See `LocalRuntimeOptimizations`. */
  optimizations?: LocalRuntimeOptimizations;
  mtp?: {
    /** Native llama.cpp MTP speculative mode. */
    specType: "draft-mtp";
    /** Default draft range passed to the native MTP runner. */
    draftMin: number;
    draftMax: number;
    /** GPU layer placement for MTP heads when the runtime exposes it. */
    gpuLayers: number | "auto";
  };
  dflash?: {
    /** Hidden companion model id containing the DFlash drafter GGUF. */
    drafterModelId: string;
    specType: "dflash";
    /** Target and drafter context sizes passed to llama-server. */
    contextSize: number;
    draftContextSize: number;
    draftMin: number;
    draftMax: number;
    gpuLayers: number | "auto";
    draftGpuLayers: number | "auto";
    disableThinking: boolean;
    /** Catalog-side rollout gate for tiers that are intentionally disabled. */
    disabledReason?: string;
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
 * Tokenizer family identifier for local GGUF catalog entries. Add new
 * families here as the catalog grows.
 */
export type TokenizerFamily =
  | "qwen35"
  | "eliza1"
  | "sentencepiece"
  | (string & {});

export type CatalogHub = "huggingface" | "modelscope";

export type CatalogQuantizationId =
  | "q3_k_m"
  | "q4_0"
  | "q4_k_m"
  | "q5_k_m"
  | "q6_k"
  | "q8_0";

export interface CatalogQuantizationVariant {
  id: CatalogQuantizationId;
  label: "3-bit" | "4-bit" | "5-bit" | "6-bit" | "8-bit";
  ggufFile: string;
  sizeGb: number;
  minRamGb: number;
  status: "published" | "planned";
}

export interface CatalogQuantization {
  defaultVariantId: CatalogQuantizationId;
  variants: CatalogQuantizationVariant[];
}

export type CatalogQuantizationMatrix = CatalogQuantization;

export interface CatalogModel {
  /** Stable Eliza id — used as the primary key. */
  id: string;
  displayName: string;
  /** Hosting backend. Defaults to Hugging Face when omitted. */
  hub?: CatalogHub;
  /** HuggingFace repo slug, e.g. "elizaos/eliza-1". */
  hfRepo: string;
  /**
   * Optional path prefix inside `hfRepo`. Eliza-1 publishes every tier under
   * one Hugging Face model repo, so app downloads resolve bundle-relative
   * paths like `text/eliza-1-2b-128k.gguf` under `bundles/2b/`.
   */
  hfPathPrefix?: string;
  /** Exact GGUF filename in the repo. */
  ggufFile: string;
  /**
   * Optional Eliza-1 bundle manifest in the same HF repo. When present, the
   * downloader installs every file listed in the manifest and uses
   * `ggufFile` as the primary text GGUF inside that bundle.
   */
  bundleManifestFile?: string;
  /**
   * Optional SHA-256 for `bundleManifestFile`. Publish tooling should fill
   * this once the manifest is finalized so desktop downloads get the same
   * manifest authenticity check as mobile. Omitted only for local/dev
   * catalogs whose manifests are still being staged.
   */
  bundleManifestSha256?: string;
  params:
    | "360M"
    | "0.1B"
    | "0.3B"
    | "0.5B"
    | "0.8B"
    | "1B"
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
  /** Optional human-facing parameter label when `params` is normalized. */
  parameterLabel?: string;
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
  /** Runtime role for non-standard entries. */
  runtimeRole?: "chat" | "dflash-drafter";
  /** Parent chat model id when this entry is a hidden companion. */
  companionForModelId?: string;
  /** Extra catalog model ids to download alongside this model. */
  companionModelIds?: string[];
  /** Maximum context length supported by the underlying GGUF, in tokens. */
  contextLength?: number;
  /** Default GPU offload strategy for this model. */
  gpuLayers?: "auto" | number;
  /** Optional recommended hardware profile id for copy/UI sorting. */
  gpuProfile?: string;
  /** Available text quantization variants for this tier. */
  quantization?: CatalogQuantization;
  /**
   * Tokenizer/vocabulary family this GGUF emits.
   */
  tokenizerFamily?: TokenizerFamily;
  /** Voice backends whose artifacts ship in this Eliza-1 bundle. */
  voiceBackends?: ReadonlyArray<"kokoro" | "omnivoice">;
  /**
   * Provenance for the Eliza-1 v1 release shape (`releaseState=base-v1`):
   * Eliza-1 v1 is the upstream BASE models — GGUF-converted via the
   * elizaOS/llama.cpp fork and fully Eliza-optimized (every quant/kernel
   * trick in `packages/inference/AGENTS.md` §3) — but NOT fine-tuned.
   * Each entry records which upstream HF repo every shipped bundle
   * component comes from. The keys are the bundle's component slots; the
   * values are upstream repo ids (and an optional file). This is the
   * "base, not fine-tuned" provenance in the catalog — it must match the
   * `provenance.sourceModels` block in the tier's `eliza-1.manifest.json`.
   * `finetuned: false` until v2.
   */
  sourceModel?: {
    finetuned: false;
    components: Partial<
      Record<
        "text" | "voice" | "asr" | "vad" | "embedding" | "vision",
        { repo: string; file?: string }
      >
    >;
  };
  /** Runtime-specific acceleration metadata. */
  runtime?: LocalRuntimeAcceleration;
  /**
   * Whether this tier's bundle is published
   * on Hugging Face yet. Defaults to `"published"` when omitted, which
   * preserves prior behaviour for any catalog entry that doesn't set it.
   *
   *   - `"published"`: HF repo has a real manifest + weights.
   *     The recommender may route first-run users here.
   *   - `"pending"`: catalog points at a tier whose HF repo is not
   *     usable yet (404, empty manifest, or `releaseState=local-standin`).
   *     `recommendForFirstRun` falls through
   *     to the next ladder candidate. Used to keep the catalog reflecting
   *     the intended product shape while the publish pipeline catches up.
   *
   * See elizaOS/eliza#7629.
   */
  publishStatus?: "published" | "pending";
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

export interface CpuFeatureProbe {
  /** Arm NEON/Advanced SIMD (`asimd` in Linux cpuinfo). */
  neon?: boolean;
  /** Arm dot-product instructions (`asimddp`/`dotprod`). */
  dotprod?: boolean;
  /** Arm int8 matrix multiply instructions. */
  i8mm?: boolean;
  /** Arm Scalable Vector Extension. */
  sve?: boolean;
  /** Arm Scalable Vector Extension v2. */
  sve2?: boolean;
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
  /** Optional CPU ISA features detected from the host OS. */
  cpuFeatures?: CpuFeatureProbe;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  /** True on Apple Silicon (shared memory — large models are viable on 16GB+). */
  appleSilicon: boolean;
  /** Recommended default bucket based on available memory. */
  recommendedBucket: ModelBucket;
  /**
   * Source of the probe. `"capacitor-llama"` when GPU values come from a loaded
   * Capacitor-llama context (mobile binding or desktop bun:ffi). `"os-fallback"`
   * means the probe was synthesized from OS-level CPU/RAM only because no
   * llama.cpp context was available to query for GPU/VRAM state.
   */
  source: "capacitor-llama" | "os-fallback";
  /** OpenVINO CPU/GPU/NPU availability hints for Intel hosts. */
  openvino?: OpenVinoHardwareProbe;
  /** Mobile-only details used for minspec, storage, and native runtime gating. */
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
