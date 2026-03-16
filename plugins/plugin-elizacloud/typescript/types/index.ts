export interface OpenAITranscriptionParams {
  audio: Blob | File | Buffer;
  model?: string;
  language?: string;
  response_format?: string;
  prompt?: string;
  temperature?: number;
  timestampGranularities?: string[];
  mimeType?: string;
}

export interface OpenAITextToSpeechParams {
  text: string;
  model?: string;
  voice?: string;
  format?: "mp3" | "wav" | "flac" | string;
  instructions?: string;
}

export interface ImageDescriptionResult {
  title: string;
  description: string;
}

export interface OpenAIConfig {
  apiKey?: string;
  baseURL?: string;
  embeddingApiKey?: string;
  embeddingURL?: string;
  smallModel?: string;
  largeModel?: string;
  imageDescriptionModel?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
}

// Re-export all cloud types
export type {
  CloudContainer,
  CloudCredentials,
  CloudPluginConfig,
  ContainerStatus,
  ContainerBillingStatus,
  ContainerArchitecture,
  CreateContainerRequest,
  CreateContainerResponse,
  ContainerListResponse,
  ContainerGetResponse,
  ContainerDeleteResponse,
  ContainerHealthResponse,
  DevicePlatform,
  DeviceAuthRequest,
  DeviceAuthResponse,
  CreditBalanceResponse,
  CreditSummaryResponse,
  CreditTransaction,
  BridgeConnectionState,
  BridgeConnection,
  BridgeMessage,
  BridgeError,
  BridgeMessageHandler,
  AgentSnapshot,
  SnapshotType,
  CreateSnapshotRequest,
  CreateSnapshotResponse,
  SnapshotListResponse,
  RestoreSnapshotRequest,
  RestoreSnapshotResponse,
  InferenceMode,
  CloudApiErrorBody,
} from "./cloud";

export {
  DEFAULT_CLOUD_CONFIG,
  CloudApiError,
  InsufficientCreditsError,
} from "./cloud";
