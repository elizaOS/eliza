/**
 * Local inference model-management types.
 *
 * Shared across the service layer, API routes, and renderer.
 * The catalog is Milady-curated; installed models are tracked locally in a
 * JSON registry under the state dir.
 */

export type ModelBucket = "small" | "mid" | "large" | "xl";

export type ModelCategory =
  | "chat"
  | "code"
  | "tools"
  | "tiny"
  | "reasoning"
  | "embedding";

export interface CatalogModel {
  /** Stable Milady id — used as the primary key. */
  id: string;
  displayName: string;
  /** HuggingFace repo slug, e.g. "bartowski/Llama-3.2-3B-Instruct-GGUF". */
  hfRepo: string;
  /** Exact GGUF filename in the repo. */
  ggufFile: string;
  params:
    | "33M"
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
  /** Output width for `category === "embedding"` models; shown in hub UI. */
  embeddingDimensions?: number;
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
  /** SHA256 of the GGUF file recorded at install time. Optional for legacy entries. */
  sha256?: string;
  /** ISO timestamp of the last successful re-verification. Absent = never verified since install. */
  lastVerifiedAt?: string;
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

/**
 * Agent model-type slots Milady lets the user wire to local models. These
 * match the `ModelType` enum in `@elizaos/core` — kept as string literals
 * here so the types file stays framework-free.
 */
export type AgentModelSlot =
  | "TEXT_SMALL"
  | "TEXT_LARGE"
  | "TEXT_EMBEDDING"
  | "OBJECT_SMALL"
  | "OBJECT_LARGE";

export const AGENT_MODEL_SLOTS: AgentModelSlot[] = [
  "TEXT_SMALL",
  "TEXT_LARGE",
  "TEXT_EMBEDDING",
  "OBJECT_SMALL",
  "OBJECT_LARGE",
];

/** User-configured mapping of agent model slots → installed model ids. */
export type ModelAssignments = Partial<Record<AgentModelSlot, string>>;

/** Probed HTTP backends for local AI engines (hub diagnostics). */
export type ExternalLlmRuntimeId = "ollama" | "lmstudio" | "vllm" | "jan";

/**
 * Which source gates **`isExternalLocalLlmInferenceReady`** for Milady-local GGUF
 * suppression against HTTP hubs. **`any`** = any ready local AI engine probe row
 * row (default). A hub id = only that probe row. **`milady-gguf`** = ignore those
 * probes (always “not externally ready” here) so in-app llama.cpp is not
 * auto-suppressed on their account.
 */
export type ExternalLlmAutodetectFocus =
  | "any"
  | ExternalLlmRuntimeId
  | "milady-gguf";

export interface ExternalLlmRuntimeRow {
  id: ExternalLlmRuntimeId;
  displayName: string;
  reachable: boolean;
  endpoint: string;
  models: string[];
  hasDownloadedModels: boolean;
  error?: string;
  /**
   * Ollama only: `GET /api/ps` — models currently resident in memory when the
   * endpoint is supported (undefined if the probe failed or returned non-JSON).
   */
  ollamaRunningModelCount?: number;
  /**
   * Ollama only: names from `/api/tags` that look **fully local** (no
   * `remote_model` / `remote_host`, positive `size` when present). Used for
   * `OPENAI_EMBEDDING_MODEL` listing so cloud/registry entries are not offered as
   * “downloaded”.
   */
  ollamaLocalModelNames?: string[];
  /**
   * LM Studio only: sum of `loaded_instances` lengths from **`GET /api/v1/models`**
   * when that native response parses (0 means models are on disk but ejected /
   * not loaded in the LM Studio UI — stricter than OpenAI’s `/v1/models` list).
   */
  lmStudioLoadedInstanceCount?: number;
  /**
   * When true, the Milady model router may skip in-app GGUF for this host to
   * avoid loading a second huge stack. **Ollama:** pulled models **and**
   * (`/api/ps` shows ≥1 runner **or** `/api/ps` unavailable). **LM Studio:**
   * OpenAI-compat `/v1/models` lists ids **and** native `/api/v1/models` shows
   * ≥1 `loaded_instances` entry when that probe succeeds (otherwise falls back
   * to list-only). **vLLM / Jan:** listed **`/v1/models`** ids only (Jan’s local
   * server defaults to **1337**; set **`JAN_API_KEY`** Bearer or probes may get 401).
   */
  routerInferenceReady?: boolean;
}

export interface ModelHubSnapshot {
  catalog: CatalogModel[];
  installed: InstalledModel[];
  active: ActiveModelState;
  downloads: DownloadJob[];
  hardware: HardwareProbe;
  assignments: ModelAssignments;
  /** Fixed probe rows (see `ExternalLlmRuntimeId`) from a quick HTTP probe. */
  externalRuntimes: ExternalLlmRuntimeRow[];
}
