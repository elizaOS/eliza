"""Type definitions for the Groq plugin."""

from enum import Enum

from pydantic import BaseModel, Field


class MessageRole(str, Enum):
    """Chat message role."""

    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"


class ChatMessage(BaseModel):
    """A chat message."""

    role: MessageRole
    content: str


class GenerateTextParams(BaseModel):
    """Parameters for text generation."""

    prompt: str
    system: str | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, gt=0)
    frequency_penalty: float | None = Field(default=None, ge=-2.0, le=2.0)
    presence_penalty: float | None = Field(default=None, ge=-2.0, le=2.0)
    stop: list[str] = Field(default_factory=list)


class GenerateObjectParams(BaseModel):
    """Parameters for object generation."""

    prompt: str
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)


class TranscriptionParams(BaseModel):
    """Parameters for audio transcription."""

    audio: bytes
    format: str = "mp3"


class TextToSpeechParams(BaseModel):
    """Parameters for text-to-speech."""

    text: str
    voice: str | None = None


class GroqConfig(BaseModel):
    """Configuration for the Groq client."""

    api_key: str
    base_url: str = "https://api.groq.com/openai/v1"
    small_model: str = "llama-3.1-8b-instant"
    large_model: str = "llama-3.3-70b-versatile"
    tts_model: str = "playai-tts"
    tts_voice: str = "Chip-PlayAI"
    transcription_model: str = "distil-whisper-large-v3-en"


class ChatCompletionRequest(BaseModel):
    """Chat completion request."""

    model: str
    messages: list[ChatMessage]
    temperature: float | None = None
    max_tokens: int | None = None
    frequency_penalty: float | None = None
    presence_penalty: float | None = None
    stop: list[str] | None = None


class ChatChoice(BaseModel):
    """A completion choice."""

    index: int
    message: ChatMessage
    finish_reason: str | None = None


class ChatCompletionResponse(BaseModel):
    """Chat completion response."""

    id: str
    model: str
    choices: list[ChatChoice]


class TranscriptionResponse(BaseModel):
    """Transcription response."""

    text: str


class ModelInfo(BaseModel):
    """Model information."""

    id: str
    owned_by: str


class ModelsResponse(BaseModel):
    """Models list response."""

    data: list[ModelInfo]
