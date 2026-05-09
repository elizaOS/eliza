/**
 * Local inference model-management types.
 *
 * Shared across the service layer, API routes, and renderer.
 * The catalog is Eliza-curated; installed models are tracked locally in a
 * JSON registry under the state dir.
 */

export type ModelBucket = "small" | "mid" | "large" | "xl";

export type ModelCategory =
  | "chat"
  | "code"
  | "tools"
  | "tiny"
  | "reasoning"
  | "drafter";

export type LocalRuntimeBackend = "node-llama-cpp" | "llama-server";

export interface LocalRuntimeAcceleration {
  /**
   * Prefer out-of-process llama-server over the node binding when the
   * required binary and companion files are available.
   */
  preferredBackend?: LocalRuntimeBackend;
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
    /** Qwen3.5/3.6 DFlash drafters are trained against non-thinking text. */
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

export interface CatalogModel {
  /** Stable Eliza id — used as the primary key. */
  id: string;
  displayName: string;
  /** HuggingFace repo slug, e.g. "bartowski/Llama-3.2-3B-Instruct-GGUF". */
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
    | "32B"
    | "70B";
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
  /** Runtime-specific acceleration metadata. */
  runtime?: LocalRuntimeAcceleration;
}

export type HardwareFitLevel = "fits" | "tight" | "wontfit";

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
}

export interface InstalledModel {
  /** Matches CatalogModel.id when installed from the curated catalog. */
  id: string;
  displayName: string;
  /** Absolute path to the GGUF file on disk. */
  path: string;
  sizeBytes: number;
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
}

export interface DownloadEvent {
  type: "progress" | "completed" | "failed" | "cancelled";
  job: DownloadJob;
}

/**
 * Agent model-type slots Eliza lets the user wire to local models. These
 * match the `ModelType` enum in `@elizaos/core` — kept as string literals
 * here so the types file stays framework-free.
 */
export type AgentModelSlot = "TEXT_SMALL" | "TEXT_LARGE" | "TEXT_EMBEDDING";

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

/** User-configured mapping of agent model slots → installed model ids. */
export type ModelAssignments = Partial<Record<AgentModelSlot, string>>;

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
