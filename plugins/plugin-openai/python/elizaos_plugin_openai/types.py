"""
OpenAI Plugin Types

Strong types with Pydantic validation for all API interactions.
"""

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, field_validator


# ============================================================================
# Enums
# ============================================================================


class AudioFormat(str, Enum):
    """Supported audio formats for transcription."""

    MP3 = "mp3"
    WAV = "wav"
    WEBM = "webm"
    OGG = "ogg"
    FLAC = "flac"
    MP4 = "mp4"


class TranscriptionResponseFormat(str, Enum):
    """Supported response formats for transcription."""

    JSON = "json"
    TEXT = "text"
    SRT = "srt"
    VERBOSE_JSON = "verbose_json"
    VTT = "vtt"


class TimestampGranularity(str, Enum):
    """Timestamp granularity options for transcription."""

    WORD = "word"
    SEGMENT = "segment"


class TTSVoice(str, Enum):
    """Supported TTS voices."""

    ALLOY = "alloy"
    ECHO = "echo"
    FABLE = "fable"
    ONYX = "onyx"
    NOVA = "nova"
    SHIMMER = "shimmer"


class TTSOutputFormat(str, Enum):
    """Supported TTS output formats."""

    MP3 = "mp3"
    WAV = "wav"
    FLAC = "flac"
    OPUS = "opus"
    AAC = "aac"
    PCM = "pcm"


class ImageSize(str, Enum):
    """Image sizes for DALL-E."""

    SIZE_256 = "256x256"
    SIZE_512 = "512x512"
    SIZE_1024 = "1024x1024"
    SIZE_1792_1024 = "1792x1024"
    SIZE_1024_1792 = "1024x1792"


class ImageQuality(str, Enum):
    """Image quality options."""

    STANDARD = "standard"
    HD = "hd"


class ImageStyle(str, Enum):
    """Image style options."""

    VIVID = "vivid"
    NATURAL = "natural"


# ============================================================================
# Request Parameters
# ============================================================================


class TranscriptionParams(BaseModel):
    """Parameters for audio transcription."""

    model: str = Field(default="whisper-1", description="The model to use for transcription")
    language: str | None = Field(default=None, description="The language of the audio (ISO-639-1)")
    response_format: TranscriptionResponseFormat = Field(
        default=TranscriptionResponseFormat.JSON, description="The format of the response"
    )
    prompt: str | None = Field(default=None, description="Optional prompt to guide the model")
    temperature: float = Field(
        default=0.0, ge=0.0, le=1.0, description="Sampling temperature between 0 and 1"
    )
    timestamp_granularities: list[TimestampGranularity] | None = Field(
        default=None, description="Timestamp granularity for verbose output"
    )


class TextToSpeechParams(BaseModel):
    """Parameters for text-to-speech generation."""

    text: str = Field(..., min_length=1, max_length=4096, description="The text to convert")
    model: str = Field(default="tts-1", description="The model to use")
    voice: TTSVoice = Field(default=TTSVoice.NOVA, description="The voice to use")
    response_format: TTSOutputFormat = Field(
        default=TTSOutputFormat.MP3, description="The output format"
    )
    speed: float = Field(default=1.0, ge=0.25, le=4.0, description="The speed of the speech")


class EmbeddingParams(BaseModel):
    """Parameters for embedding generation."""

    text: str = Field(..., min_length=1, description="The text to embed")
    model: str = Field(default="text-embedding-3-small", description="The model to use")
    dimensions: int | None = Field(default=None, ge=1, description="The number of dimensions")


class ImageGenerationParams(BaseModel):
    """Parameters for image generation."""

    prompt: str = Field(..., min_length=1, description="The prompt describing the image")
    model: str = Field(default="dall-e-3", description="The model to use")
    n: int = Field(default=1, ge=1, le=10, description="Number of images to generate")
    size: ImageSize = Field(default=ImageSize.SIZE_1024, description="The size of the images")
    quality: ImageQuality = Field(default=ImageQuality.STANDARD, description="The quality")
    style: ImageStyle = Field(default=ImageStyle.VIVID, description="The style")


class ImageDescriptionParams(BaseModel):
    """Parameters for image description/analysis."""

    image_url: str = Field(..., description="URL of the image to analyze")
    prompt: str = Field(
        default="Please analyze this image and provide a title and detailed description.",
        description="Custom prompt for analysis",
    )
    max_tokens: int = Field(default=8192, ge=1, description="Maximum tokens for the response")
    model: str = Field(default="gpt-5-mini", description="The model to use")


class TextGenerationParams(BaseModel):
    """Parameters for text generation."""

    prompt: str = Field(..., min_length=1, description="The prompt for generation")
    model: str = Field(default="gpt-5-mini", description="The model to use")
    system: str | None = Field(default=None, description="System message for the model")
    temperature: float = Field(default=0.7, ge=0.0, le=2.0, description="Temperature for sampling")
    max_tokens: int | None = Field(default=None, ge=1, description="Maximum output tokens")
    frequency_penalty: float = Field(
        default=0.0, ge=-2.0, le=2.0, description="Frequency penalty"
    )
    presence_penalty: float = Field(default=0.0, ge=-2.0, le=2.0, description="Presence penalty")
    stop: list[str] | None = Field(default=None, description="Stop sequences")
    stream: bool = Field(default=False, description="Whether to stream the response")


class ObjectGenerationParams(BaseModel):
    """Parameters for structured object generation."""

    prompt: str = Field(..., min_length=1, description="The prompt for generation")
    model: str = Field(default="gpt-5-mini", description="The model to use")
    temperature: float = Field(default=0.0, ge=0.0, le=2.0, description="Temperature for sampling")


# ============================================================================
# Response Types
# ============================================================================


class ImageDescriptionResult(BaseModel):
    """Result of image description/analysis."""

    title: str = Field(..., description="A title for the image")
    description: str = Field(..., description="A detailed description of the image")


class ImageGenerationResult(BaseModel):
    """Result of image generation."""

    url: str = Field(..., description="URL of the generated image")
    revised_prompt: str | None = Field(default=None, description="Revised prompt if applicable")


class TokenUsage(BaseModel):
    """Token usage statistics."""

    prompt_tokens: int = Field(..., ge=0, description="Number of prompt tokens")
    completion_tokens: int = Field(default=0, ge=0, description="Number of completion tokens (not present in embedding responses)")
    total_tokens: int = Field(..., ge=0, description="Total tokens used")


class EmbeddingData(BaseModel):
    """Single embedding data."""

    object: Literal["embedding"] = "embedding"
    embedding: list[float] = Field(..., description="The embedding vector")
    index: int = Field(..., ge=0, description="Index of the embedding")


class EmbeddingResponse(BaseModel):
    """OpenAI embedding response."""

    object: Literal["list"] = "list"
    data: list[EmbeddingData] = Field(..., description="List of embeddings")
    model: str = Field(..., description="The model used")
    usage: TokenUsage = Field(..., description="Token usage")


class ChatMessage(BaseModel):
    """Chat message."""

    role: Literal["system", "user", "assistant"] = Field(..., description="Message role")
    content: str | None = Field(default=None, description="Message content")


class ChatChoice(BaseModel):
    """Chat completion choice."""

    index: int = Field(..., ge=0, description="Choice index")
    message: ChatMessage = Field(..., description="The message")
    finish_reason: str | None = Field(default=None, description="Finish reason")


class ChatCompletionResponse(BaseModel):
    """OpenAI chat completion response."""

    id: str = Field(..., description="Completion ID")
    object: Literal["chat.completion"] = "chat.completion"
    created: int = Field(..., description="Creation timestamp")
    model: str = Field(..., description="The model used")
    choices: list[ChatChoice] = Field(..., description="Completion choices")
    usage: TokenUsage | None = Field(default=None, description="Token usage")


class ImageResponseData(BaseModel):
    """Image generation response data."""

    url: str = Field(..., description="URL of the generated image")
    revised_prompt: str | None = Field(default=None, description="Revised prompt")


class ImageGenerationResponse(BaseModel):
    """OpenAI image generation response."""

    created: int = Field(..., description="Creation timestamp")
    data: list[ImageResponseData] = Field(..., description="Generated images")


class TranscriptionResponse(BaseModel):
    """OpenAI transcription response."""

    text: str = Field(..., description="Transcribed text")
    language: str | None = Field(default=None, description="Detected language")
    duration: float | None = Field(default=None, description="Audio duration in seconds")


class ModelInfo(BaseModel):
    """OpenAI model information."""

    id: str = Field(..., description="Model ID")
    object: Literal["model"] = "model"
    created: int = Field(..., description="Creation timestamp")
    owned_by: str = Field(..., description="Owner")


class ModelsResponse(BaseModel):
    """OpenAI models list response."""

    object: Literal["list"] = "list"
    data: list[ModelInfo] = Field(..., description="List of models")


# ============================================================================
# Configuration
# ============================================================================


class OpenAIConfig(BaseModel):
    """OpenAI plugin configuration."""

    api_key: str = Field(..., min_length=1, description="OpenAI API key")
    base_url: str = Field(default="https://api.openai.com/v1", description="API base URL")
    small_model: str = Field(default="gpt-5-mini", description="Small model identifier")
    large_model: str = Field(default="gpt-5", description="Large model identifier")
    embedding_model: str = Field(
        default="text-embedding-3-small", description="Embedding model identifier"
    )
    embedding_dimensions: int = Field(default=1536, ge=1, description="Embedding dimensions")
    tts_model: str = Field(default="tts-1", description="TTS model identifier")
    tts_voice: TTSVoice = Field(default=TTSVoice.NOVA, description="TTS voice")
    transcription_model: str = Field(default="whisper-1", description="Transcription model")
    image_model: str = Field(default="dall-e-3", description="Image generation model")
    timeout: float = Field(default=60.0, ge=1.0, description="Request timeout in seconds")

    @field_validator("api_key")
    @classmethod
    def validate_api_key(cls, v: str) -> str:
        """Validate API key format."""
        if not v.startswith("sk-"):
            raise ValueError("API key must start with 'sk-'")
        return v

