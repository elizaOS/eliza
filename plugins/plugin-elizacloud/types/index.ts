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
  AgentSnapshot,
  BridgeConnection,
  BridgeConnectionState,
  BridgeError,
  BridgeMessage,
  BridgeMessageHandler,
  CloudApiErrorBody,
  CloudContainer,
  CloudCredentials,
  CloudPluginConfig,
  ContainerArchitecture,
  ContainerBillingStatus,
  ContainerDeleteResponse,
  ContainerGetResponse,
  ContainerHealthResponse,
  ContainerListResponse,
  ContainerStatus,
  CreateContainerRequest,
  CreateContainerResponse,
  CreateSnapshotRequest,
  CreateSnapshotResponse,
  CreditBalanceResponse,
  CreditSummaryResponse,
  CreditTransaction,
  DeviceAuthRequest,
  DeviceAuthResponse,
  DevicePlatform,
  GatewayRelayRequest,
  GatewayRelayRequestEnvelope,
  GatewayRelayResponse,
  GatewayRelaySession,
  InferenceMode,
  PollGatewayRelayResponse,
  RegisterGatewayRelaySessionResponse,
  RestoreSnapshotRequest,
  RestoreSnapshotResponse,
  SnapshotListResponse,
  SnapshotType,
} from "./cloud";

export {
  CloudApiError,
  DEFAULT_CLOUD_CONFIG,
  InsufficientCreditsError,
} from "./cloud";
