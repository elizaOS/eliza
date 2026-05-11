/**
 * Local inference model-management types (server-side superset).
 *
 * Shared across the service layer, API routes, and renderer.
 * The catalog is Eliza-curated; installed models are tracked locally in a
 * JSON registry under the state dir.
 *
 * Foundational types that are byte-identical between the server and the
 * UI client (`AgentModelSlot`, `InstalledModel`, `ModelAssignments`,
 * `TextGenerationSlot`, `AGENT_MODEL_SLOTS`) live in
 * `@elizaos/shared/local-inference` and are re-exported here so existing
 * import paths keep working. The server-only DFlash kernel /
 * optimization / loaded-cache types remain in this file because no UI
 * consumer needs them.
 */

import {
  AGENT_MODEL_SLOTS,
  type AgentModelSlot,
  type InstalledModel,
  type ModelAssignments,
  type TextGenerationSlot,
} from "@elizaos/shared";

export {
  AGENT_MODEL_SLOTS,
  type AgentModelSlot,
  type InstalledModel,
  type ModelAssignments,
  type TextGenerationSlot,
};

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
 * Tokenizer family — names match the upstream model family the GGUF was
 * trained against. Used by the DFlash drafter pair guard, by the catalog
 * blurbs, and by any downstream code that needs to make tokenizer-aware
 * decisions (e.g. spec-decode pairing requires drafter and target to share
 * the exact vocabulary). Open string union so new families can be added
 * without a code change in every consumer; the canonical members are
 * enumerated for tooling.
 */
export type TokenizerFamily = "eliza1" | "sentencepiece" | (string & {});

export interface CatalogModel {
  /** Stable Eliza id — used as the primary key. */
  id: string;
  displayName: string;
  /** HuggingFace repo slug, e.g. "elizalabs/eliza-1-1_7b". */
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
  /**
   * Maximum context length supported by the underlying GGUF, in tokens.
   * This is the GGUF ceiling — actual load-time `contextSize` may be
   * smaller (capped by the loader's runtime budget). When unset, callers
   * should treat the model as opting into the loader's default
   * (`"auto"` for `node-llama-cpp`, model file's reported `n_ctx_train`).
   *
   * Long-context models (>= 65k) get a small ranking boost on hosts with
   * enough RAM/VRAM in `selectRecommendedModelForSlot`; see
   * `recommendation.ts`.
   */
  contextLength?: number;
  /**
   * Default GPU offload strategy for this model. `"auto"` lets the loader
   * decide based on VRAM probing; a number forces that many layers to
   * VRAM. Per-load overrides (`LocalInferenceLoadArgs.gpuLayers`) win
   * over this default.
   */
  gpuLayers?: "auto" | number;
  /**
   * Tokenizer family the GGUF was trained against. Used by the DFlash
   * drafter pair guard (drafter and target MUST share the same family
   * for spec-decode to work) and by recommendation/UI code that needs
   * to surface family-aware messaging.
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

// AgentModelSlot, TextGenerationSlot, AGENT_MODEL_SLOTS, ModelAssignments
// are re-exported above from @elizaos/shared.

export const TEXT_GENERATION_SLOTS: TextGenerationSlot[] = [
  "TEXT_SMALL",
  "TEXT_LARGE",
];

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
