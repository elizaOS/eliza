from dataclasses import dataclass, field
from typing import Literal

# Re-export all cloud types
from elizaos_plugin_elizacloud.types.cloud import (
    AgentSnapshot,
    BackupConfig,
    BridgeConfig,
    BridgeConnection,
    BridgeConnectionState,
    BridgeError,
    BridgeMessage,
    CloudApiError,
    CloudApiErrorBody,
    CloudContainer,
    CloudCredentials,
    CloudPluginConfig,
    ContainerArchitecture,
    ContainerBillingStatus,
    ContainerDefaults,
    ContainerHealthData,
    ContainerHealthResponse,
    ContainerStatus,
    CreateContainerRequest,
    CreateContainerResponse,
    CreateSnapshotRequest,
    CreateSnapshotResponse,
    CreditBalanceData,
    CreditBalanceResponse,
    CreditSummaryData,
    CreditSummaryResponse,
    CreditTransaction,
    DEFAULT_CLOUD_CONFIG,
    DeviceAuthData,
    DeviceAuthRequest,
    DeviceAuthResponse,
    DevicePlatform,
    InferenceMode,
    InsufficientCreditsError,
    RestoreSnapshotRequest,
    RestoreSnapshotResponse,
    SnapshotListResponse,
    SnapshotType,
)


@dataclass
class ElizaCloudConfig:
    api_key: str
    base_url: str = "https://www.elizacloud.ai/api/v1"
    small_model: str = "gpt-5-mini"
    large_model: str = "gpt-5"
    embedding_model: str = "text-embedding-3-small"
    embedding_dimensions: int = 1536
    embedding_api_key: str | None = None
    embedding_url: str | None = None
    image_description_model: str = "gpt-5-mini"
    image_description_max_tokens: int = 8192
    image_generation_model: str = "dall-e-3"
    tts_model: str = "gpt-5-mini-tts"
    tts_voice: str = "nova"
    tts_instructions: str | None = None
    transcription_model: str = "gpt-5-mini-transcribe"
    experimental_telemetry: bool = False


@dataclass
class TextGenerationParams:
    prompt: str
    temperature: float = 0.7
    max_tokens: int = 8192
    frequency_penalty: float = 0.7
    presence_penalty: float = 0.7
    stop_sequences: list[str] = field(default_factory=list)
    stream: bool = False


@dataclass
class ObjectGenerationParams:
    prompt: str
    schema: dict[str, object] | None = None
    temperature: float = 0.0


@dataclass
class TextEmbeddingParams:
    text: str | None = None
    texts: list[str] | None = None
    model: str | None = None


@dataclass
class ImageGenerationParams:
    prompt: str
    count: int = 1
    size: str = "1024x1024"
    quality: str = "standard"
    style: str = "vivid"


@dataclass
class ImageDescriptionParams:
    image_url: str
    prompt: str | None = None


@dataclass
class ImageDescriptionResult:
    title: str
    description: str


@dataclass
class TextToSpeechParams:
    text: str
    model: str | None = None
    voice: str | None = None
    format: Literal["mp3", "wav", "flac"] = "mp3"
    instructions: str | None = None


@dataclass
class TranscriptionParams:
    audio: bytes
    model: str | None = None
    language: str | None = None
    response_format: str = "text"
    prompt: str | None = None
    temperature: float | None = None
    mime_type: str = "audio/wav"
    timestamp_granularities: list[str] | None = None


@dataclass
class TokenizeTextParams:
    """Parameters for text tokenization."""

    prompt: str
    model_type: str = "TEXT_LARGE"


@dataclass
class DetokenizeTextParams:
    tokens: list[int]
    model_type: str = "TEXT_LARGE"


__all__ = [
    # Inference types
    "ElizaCloudConfig",
    "TextGenerationParams",
    "ObjectGenerationParams",
    "TextEmbeddingParams",
    "ImageGenerationParams",
    "ImageDescriptionParams",
    "ImageDescriptionResult",
    "TextToSpeechParams",
    "TranscriptionParams",
    "TokenizeTextParams",
    "DetokenizeTextParams",
    # Cloud types
    "ContainerStatus",
    "ContainerBillingStatus",
    "ContainerArchitecture",
    "CloudContainer",
    "CreateContainerRequest",
    "CreateContainerResponse",
    "ContainerHealthData",
    "ContainerHealthResponse",
    "DevicePlatform",
    "DeviceAuthRequest",
    "DeviceAuthData",
    "DeviceAuthResponse",
    "CloudCredentials",
    "CreditBalanceData",
    "CreditBalanceResponse",
    "CreditTransaction",
    "CreditSummaryData",
    "CreditSummaryResponse",
    "BridgeConnectionState",
    "BridgeError",
    "BridgeMessage",
    "BridgeConnection",
    "SnapshotType",
    "AgentSnapshot",
    "CreateSnapshotRequest",
    "CreateSnapshotResponse",
    "SnapshotListResponse",
    "RestoreSnapshotRequest",
    "RestoreSnapshotResponse",
    "InferenceMode",
    "BridgeConfig",
    "BackupConfig",
    "ContainerDefaults",
    "CloudPluginConfig",
    "DEFAULT_CLOUD_CONFIG",
    "CloudApiErrorBody",
    "CloudApiError",
    "InsufficientCreditsError",
]
