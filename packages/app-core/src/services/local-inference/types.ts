/**
 * Local inference model-management types.
 *
 * Shared across the service layer, API routes, and renderer.
 * The catalog is Milady-curated; installed models are tracked locally in a
 * JSON registry under the state dir.
 */

export type ModelBucket = "small" | "mid" | "large" | "xl";

export type ModelCategory = "chat" | "code" | "tools" | "tiny" | "reasoning";

export interface CatalogModel {
  /** Stable Milady id — used as the primary key. */
  id: string;
  displayName: string;
  /** HuggingFace repo slug, e.g. "bartowski/Llama-3.2-3B-Instruct-GGUF". */
  hfRepo: string;
  /** Exact GGUF filename in the repo. */
  ggufFile: string;
  params:
    | "1B"
    | "1.7B"
    | "3B"
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
  /** True on Apple Silicon (unified memory — large models are viable on 16GB+). */
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
  /** Where we got this model from. Determines whether Milady owns the file. */
  source: "milady-download" | "external-scan";
  /**
   * When source === "external-scan", which tool the file belonged to.
   * Prevents Milady from deleting files other apps own.
   */
  externalOrigin?:
    | "lm-studio"
    | "jan"
    | "ollama"
    | "huggingface"
    | "text-gen-webui";
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

export interface ModelHubSnapshot {
  catalog: CatalogModel[];
  installed: InstalledModel[];
  active: ActiveModelState;
  downloads: DownloadJob[];
  hardware: HardwareProbe;
}
