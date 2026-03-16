from enum import Enum

from pydantic import BaseModel, Field


class MessageRole(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"


class ChatMessage(BaseModel):
    role: MessageRole
    content: str


class GenerateTextParams(BaseModel):
    prompt: str
    system: str | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, gt=0)
    frequency_penalty: float | None = Field(default=None, ge=-2.0, le=2.0)
    presence_penalty: float | None = Field(default=None, ge=-2.0, le=2.0)
    stop: list[str] = Field(default_factory=list)


class GenerateObjectParams(BaseModel):
    prompt: str
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)


class TranscriptionParams(BaseModel):
    audio: bytes
    format: str = "mp3"


class TextToSpeechParams(BaseModel):
    text: str
    voice: str | None = None


class GroqConfig(BaseModel):
    api_key: str
    base_url: str = "https://api.groq.com/openai/v1"
    small_model: str = "llama-3.1-8b-instant"
    large_model: str = "llama-3.3-70b-versatile"
    tts_model: str = "playai-tts"
    tts_voice: str = "Chip-PlayAI"
    transcription_model: str = "distil-whisper-large-v3-en"


class ChatCompletionRequest(BaseModel):
    model: str
    messages: list[ChatMessage]
    temperature: float | None = None
    max_tokens: int | None = None
    frequency_penalty: float | None = None
    presence_penalty: float | None = None
    stop: list[str] | None = None


class ChatChoice(BaseModel):
    index: int
    message: ChatMessage
    finish_reason: str | None = None


class ChatCompletionResponse(BaseModel):
    id: str
    model: str
    choices: list[ChatChoice]


class TranscriptionResponse(BaseModel):
    text: str


class ModelInfo(BaseModel):
    id: str
    owned_by: str


class ModelsResponse(BaseModel):
    data: list[ModelInfo]
