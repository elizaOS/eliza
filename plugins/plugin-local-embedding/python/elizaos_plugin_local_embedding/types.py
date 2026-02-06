from __future__ import annotations

from pydantic import BaseModel, Field


class TokenizerConfig(BaseModel):
    """Configuration for a tokenizer."""

    name: str
    tokenizer_type: str = Field(alias="type")

    model_config = {"populate_by_name": True}


class ModelSpec(BaseModel):
    """Specification for a language model."""

    name: str
    repo: str
    size: str
    quantization: str
    context_size: int
    tokenizer: TokenizerConfig


class EmbeddingModelSpec(BaseModel):
    """Specification for an embedding model with a dimensions field."""

    name: str
    repo: str
    size: str
    quantization: str
    context_size: int
    dimensions: int
    tokenizer: TokenizerConfig


# ---- Request / response types for model handlers ----


class EmbeddingParams(BaseModel):
    """Parameters for generating a text embedding."""

    text: str


class EmbeddingResponse(BaseModel):
    """Response from embedding generation."""

    embedding: list[float]
    dimensions: int


class TokenEncodeParams(BaseModel):
    """Parameters for encoding text to token IDs."""

    text: str


class TokenEncodeResponse(BaseModel):
    """Response from text encoding."""

    tokens: list[int]


class TokenDecodeParams(BaseModel):
    """Parameters for decoding token IDs to text."""

    tokens: list[int]


class TokenDecodeResponse(BaseModel):
    """Response from token decoding."""

    text: str


class ModelSpecs:
    """Predefined model specifications matching the TypeScript implementation."""

    @staticmethod
    def embedding() -> EmbeddingModelSpec:
        """Default embedding model specification (BGE-small-en-v1.5)."""
        return EmbeddingModelSpec(
            name="bge-small-en-v1.5.Q4_K_M.gguf",
            repo="ChristianAzinn/bge-small-en-v1.5-gguf",
            size="133 MB",
            quantization="Q4_K_M",
            context_size=512,
            dimensions=384,
            tokenizer=TokenizerConfig(
                name="BAAI/bge-small-en-v1.5",
                tokenizer_type="bert",
            ),
        )

    @staticmethod
    def small() -> ModelSpec:
        """Default small language model specification."""
        return ModelSpec(
            name="DeepHermes-3-Llama-3-3B-Preview-q4.gguf",
            repo="NousResearch/DeepHermes-3-Llama-3-3B-Preview-GGUF",
            size="3B",
            quantization="Q4_0",
            context_size=8192,
            tokenizer=TokenizerConfig(
                name="NousResearch/DeepHermes-3-Llama-3-3B-Preview",
                tokenizer_type="llama",
            ),
        )

    @staticmethod
    def medium() -> ModelSpec:
        """Default medium language model specification."""
        return ModelSpec(
            name="DeepHermes-3-Llama-3-8B-q4.gguf",
            repo="NousResearch/DeepHermes-3-Llama-3-8B-Preview-GGUF",
            size="8B",
            quantization="Q4_0",
            context_size=8192,
            tokenizer=TokenizerConfig(
                name="NousResearch/DeepHermes-3-Llama-3-8B-Preview",
                tokenizer_type="llama",
            ),
        )
