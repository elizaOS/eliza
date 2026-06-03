export const MODEL_REMOTE_ID = "eliza.local-model" as const;
export const ELIZA_1_HF_REPO = "elizaos/eliza-1" as const;

export type ModelRemoteErrorCode =
  | "MODEL_API_BASE_MISSING"
  | "MODEL_LOCAL_INFERENCE_UNAVAILABLE"
  | "MODEL_ROUTE_UNAVAILABLE"
  | "MODEL_NOT_FOUND"
  | "MODEL_NOT_INSTALLED"
  | "MODEL_DOWNLOAD_FAILED"
  | "MODEL_ACTIVATION_FAILED"
  | "MODEL_GENERATION_UNAVAILABLE"
  | "MODEL_EMBEDDING_UNAVAILABLE"
  | "MODEL_REQUEST_FAILED"
  | "MODEL_UNKNOWN";

export type ModelRemoteError = {
  code: ModelRemoteErrorCode;
  message: string;
  modelId?: string;
  path?: string;
  status?: number;
  details?: unknown;
};

export type LocalModelRole =
  | "chat"
  | "embedding"
  | "drafter"
  | "vision"
  | "image"
  | "tts"
  | "stt"
  | "vad"
  | "voice"
  | "turn"
  | "emotion";

export type LocalModelCapability =
  | "text-generation"
  | "text-embedding"
  | "vision"
  | "image-generation"
  | "mtp"
  | "text-to-speech"
  | "speech-to-text"
  | "voice-activity-detection"
  | "turn-detection"
  | "emotion-classification"
  | "speaker-embedding";

export type LocalModelProviderId =
  | "eliza-1"
  | "eliza-local-inference"
  | "llama-cpp"
  | "ollama"
  | "external";

export type LocalModelCatalogEntry = {
  id: string;
  displayName: string;
  provider: LocalModelProviderId;
  family: "eliza-1" | "ollama" | "external";
  hfRepo: "elizaos/eliza-1" | string;
  bundlePath?: string;
  tier?: string;
  params?: string;
  sizeGb?: number;
  minRamGb?: number;
  contextLength?: number;
  quantization?: string;
  roles: LocalModelRole[];
  capabilities: LocalModelCapability[];
  installed?: boolean;
  active?: boolean;
  default?: boolean;
  source?: unknown;
  raw?: unknown;
};

export type Eliza1BundleTier = {
  tier: string;
  bundlePath: string;
  displayName: string;
  params?: string;
  visibleOnHf: boolean;
  activeTier?: boolean;
  contextLength?: number;
  roles: LocalModelRole[];
  capabilities: LocalModelCapability[];
  raw?: unknown;
};

export type Eliza1VoiceComponent = {
  id: string;
  path: string;
  displayName: string;
  roles: LocalModelRole[];
  capabilities: LocalModelCapability[];
  files?: string[];
  raw?: unknown;
};

export type LocalModelInstalledEntry = {
  id: string;
  displayName?: string;
  path: string;
  sizeBytes?: number;
  hfRepo?: string;
  bundlePath?: string;
  installedAt?: string;
  lastUsedAt?: string | null;
  sha256?: string;
  lastVerifiedAt?: string;
  raw?: unknown;
};

export type LocalModelDownloadState =
  | "queued"
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type LocalModelDownloadJob = {
  jobId: string;
  modelId: string;
  state: LocalModelDownloadState;
  received?: number;
  total?: number;
  bytesPerSec?: number;
  etaMs?: number | null;
  startedAt?: string;
  updatedAt?: string;
  error?: string;
  raw?: unknown;
};

export type LocalModelActiveSnapshot = {
  modelId: string | null;
  loadedAt?: string | null;
  status: "idle" | "loading" | "ready" | "error" | "unknown";
  provider?: string;
  error?: string;
  raw?: unknown;
};

export type LocalModelHardwareSnapshot = {
  totalRamGb?: number;
  freeRamGb?: number;
  gpu?: unknown;
  cpuCores?: number;
  platform?: string;
  arch?: string;
  appleSilicon?: boolean;
  recommendedTier?: string;
  source?: string;
  raw?: unknown;
};

export type LocalModelHubSnapshot = {
  catalog: LocalModelCatalogEntry[];
  eliza1Tiers: Eliza1BundleTier[];
  voiceComponents: Eliza1VoiceComponent[];
  installed: LocalModelInstalledEntry[];
  active: LocalModelActiveSnapshot;
  downloads: LocalModelDownloadJob[];
  hardware?: LocalModelHardwareSnapshot;
  assignments?: Record<string, string>;
  routing?: unknown;
  raw?: unknown;
};

export type LocalModelGenerateParams = {
  modelId?: string;
  prompt: string;
  systemPrompt?: string;
  messages?: Array<{
    role: "system" | "user" | "assistant" | string;
    content: string;
  }>;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stopSequences?: string[];
};

export type LocalModelGenerateResult = {
  ok: boolean;
  modelId?: string;
  provider?: string;
  text?: string;
  raw?: unknown;
};

export type LocalModelEmbeddingParams = {
  modelId?: string;
  input: string;
};

export type LocalModelEmbeddingResult = {
  modelId?: string;
  provider?: string;
  embedding: number[];
  dimensions: number;
  raw?: unknown;
};

export type ModelMethod =
  | "model.status"
  | "model.hub"
  | "model.catalog"
  | "model.catalog.eliza1"
  | "model.eliza1.tiers"
  | "model.eliza1.voice"
  | "model.hf.metadata"
  | "model.providers"
  | "model.hardware"
  | "model.installed"
  | "model.download.start"
  | "model.download.cancel"
  | "model.downloads"
  | "model.active"
  | "model.activate"
  | "model.unload"
  | "model.assignments"
  | "model.assignment.set"
  | "model.routing"
  | "model.routing.set"
  | "model.routing.useLocal"
  | "model.routing.useCloud"
  | "model.generate"
  | "model.embedding"
  | "model.capabilities";

export type ModelEventName =
  | "model.download.started"
  | "model.download.progress"
  | "model.download.completed"
  | "model.download.failed"
  | "model.active.changed"
  | "model.error";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue }
  | JsonValue[];

export type ModelWorkerRequestMessage = {
  type: "request";
  requestId: string | number;
  method: ModelMethod;
  params?: JsonValue;
};

export type ModelResponsePayload =
  | LocalModelHubSnapshot
  | LocalModelCatalogEntry[]
  | Eliza1BundleTier[]
  | Eliza1VoiceComponent[]
  | LocalModelInstalledEntry[]
  | LocalModelDownloadJob[]
  | LocalModelDownloadJob
  | LocalModelActiveSnapshot
  | LocalModelHardwareSnapshot
  | LocalModelGenerateResult
  | LocalModelEmbeddingResult
  | Record<string, string>
  | { cancelled: boolean }
  | unknown;

export type ModelWorkerResponseMessage =
  | {
      type: "response";
      requestId: string | number;
      success: true;
      payload: ModelResponsePayload;
    }
  | {
      type: "response";
      requestId: string | number;
      success: false;
      error: ModelRemoteError;
    };

export type ModelWorkerEventMessage = {
  type: "event";
  name: ModelEventName;
  payload: ModelResponsePayload | ModelRemoteError;
};

export type ModelWorkerReadyMessage = {
  type: "ready";
};

export type ModelWorkerOutboundMessage =
  | ModelWorkerResponseMessage
  | ModelWorkerEventMessage
  | ModelWorkerReadyMessage;
