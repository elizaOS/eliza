from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class MessageRole(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"


class ImageSize(str, Enum):
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


class TextGenerationParams(BaseModel):
    prompt: str = Field(..., min_length=1, description="The prompt for generation")
    model: str | None = Field(default=None, description="Model to use (overrides config)")
    system: str | None = Field(default=None, description="System message for the model")
    temperature: float | None = Field(
        default=None, ge=0.0, le=2.0, description="Temperature for sampling"
    )
    max_tokens: int | None = Field(default=None, ge=1, description="Maximum output tokens")
    frequency_penalty: float | None = Field(
        default=None, ge=-2.0, le=2.0, description="Frequency penalty"
    )
    presence_penalty: float | None = Field(
        default=None, ge=-2.0, le=2.0, description="Presence penalty"
    )
    stop_sequences: list[str] | None = Field(default=None, description="Stop sequences")
    stream: bool = Field(default=False, description="Whether to stream the response")


class EmbeddingParams(BaseModel):
    text: str = Field(..., min_length=1, description="The text to embed")
    model: str | None = Field(default=None, description="Model to use (overrides config)")
    dimensions: int | None = Field(default=None, ge=1, description="Embedding dimensions")


class ObjectGenerationParams(BaseModel):
    prompt: str = Field(..., min_length=1, description="The prompt for generation")
    model: str | None = Field(default=None, description="Model to use (overrides config)")
    temperature: float | None = Field(
        default=None, ge=0.0, le=2.0, description="Temperature for sampling"
    )


class ImageGenerationParams(BaseModel):
    prompt: str = Field(..., min_length=1, description="The prompt describing the image")
    model: str | None = Field(default=None, description="Model to use (overrides config)")
    n: int = Field(default=1, ge=1, le=10, description="Number of images to generate")
    size: ImageSize = Field(default=ImageSize.SIZE_1024, description="Image size")
    quality: ImageQuality = Field(default=ImageQuality.STANDARD, description="Image quality")
    style: ImageStyle = Field(default=ImageStyle.VIVID, description="Image style")


class ImageDescriptionParams(BaseModel):
    image_url: str = Field(..., description="URL of the image to analyze")
    prompt: str | None = Field(
        default=None,
        description="Custom prompt for analysis",
    )
    model: str | None = Field(default=None, description="Model to use for vision")
    max_tokens: int = Field(default=8192, ge=1, description="Maximum response tokens")


class TokenUsage(BaseModel):
    prompt_tokens: int = Field(..., ge=0, description="Number of prompt tokens")
    completion_tokens: int = Field(default=0, ge=0, description="Number of completion tokens")
    total_tokens: int = Field(..., ge=0, description="Total tokens used")


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"] = Field(..., description="Message role")
    content: str | None = Field(default=None, description="Message content")


class ChatChoice(BaseModel):
    index: int = Field(..., ge=0, description="Choice index")
    message: ChatMessage = Field(..., description="The message")
    finish_reason: str | None = Field(default=None, description="Finish reason")


class ChatCompletionResponse(BaseModel):
    id: str = Field(..., description="Completion ID")
    object: Literal["chat.completion"] = "chat.completion"
    created: int = Field(..., description="Creation timestamp")
    model: str = Field(..., description="The model used")
    choices: list[ChatChoice] = Field(..., description="Completion choices")
    usage: TokenUsage | None = Field(default=None, description="Token usage")


class EmbeddingData(BaseModel):
    object: Literal["embedding"] = "embedding"
    embedding: list[float] = Field(..., description="The embedding vector")
    index: int = Field(..., ge=0, description="Index of the embedding")


class EmbeddingResponse(BaseModel):
    object: Literal["list"] = "list"
    data: list[EmbeddingData] = Field(..., description="List of embeddings")
    model: str = Field(..., description="The model used")
    usage: TokenUsage = Field(..., description="Token usage")


class ImageResponseData(BaseModel):
    url: str = Field(..., description="URL of the generated image")
    revised_prompt: str | None = Field(default=None, description="Revised prompt")


class ImageGenerationResponse(BaseModel):
    created: int = Field(..., description="Creation timestamp")
    data: list[ImageResponseData] = Field(..., description="Generated images")


class ImageGenerationResult(BaseModel):
    url: str = Field(..., description="URL of the generated image")
    revised_prompt: str | None = Field(default=None, description="Revised prompt")


class ImageDescriptionResult(BaseModel):
    title: str = Field(..., description="A title for the image")
    description: str = Field(..., description="A detailed description of the image")
