/**
 * Local inference model-management types (UI-side public subset).
 *
 * Shared across the service layer, API routes, and renderer.
 * The catalog is Eliza-curated; installed models are tracked locally in a
 * JSON registry under the state dir.
 *
 * Foundational types that are byte-identical between the UI client and the
 * app-core server (`AgentModelSlot`, `InstalledModel`, `ModelAssignments`,
 * `TextGenerationSlot`, `AGENT_MODEL_SLOTS`) live in
 * `@elizaos/shared/local-inference` and are re-exported here so existing
 * import paths keep working.
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

export type LocalRuntimeKernel =
  | "dflash"
  | "turbo3"
  | "turbo4"
  | "turbo3_tcq"
  | "qjl_full";

export interface LocalRuntimeOptimizations {
  lookahead?: number;
  ngramDraft?: { min: number; max: number; minProb: number };
  parallel?: number;
  moeOffload?: "cpu" | "none";
  mlock?: boolean;
  noMmap?: boolean;
  mmproj?: string;
  alias?: string;
  flashAttention?: boolean;
  requiresKernel?: LocalRuntimeKernel[];
}

export interface LocalRuntimeAcceleration {
  /**
   * Prefer out-of-process llama-server over the node binding when the
   * required binary and companion files are available.
   */
  preferredBackend?: LocalRuntimeBackend;
  /** Optimization knobs declared per-model. */
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
export type TokenizerFamily =
  | "eliza1"
  | "sentencepiece"
  | (string & {});

export interface CatalogModel {
  /** Stable Eliza id — used as the primary key. */
  id: string;
  displayName: string;
  /** HuggingFace repo slug, e.g. "elizalabs/eliza-1-mobile-1_7b". */
  hfRepo: string;
  /** Exact GGUF filename in the repo. */
  ggufFile: string;
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
