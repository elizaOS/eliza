"""
Types for elizaOS Knowledge Plugin.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

# Note: MemoryType should be imported directly from elizaos.types when needed


class EmbeddingProvider(str, Enum):
    """Supported embedding providers."""

    OPENAI = "openai"
    GOOGLE = "google"


class TextProvider(str, Enum):
    """Supported text generation providers."""

    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    OPENROUTER = "openrouter"
    GOOGLE = "google"


@dataclass
class KnowledgeConfig:
    """Configuration for the Knowledge service."""

    # Embedding settings
    embedding_provider: str = "openai"
    embedding_model: str = "text-embedding-3-small"
    embedding_dimension: int = 1536

    # API keys (loaded from environment if not provided)
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    google_api_key: str | None = None
    openrouter_api_key: str | None = None

    # Base URLs for providers
    openai_base_url: str | None = None
    anthropic_base_url: str | None = None
    google_base_url: str | None = None
    openrouter_base_url: str | None = None

    # Contextual Knowledge settings
    ctx_knowledge_enabled: bool = False
    text_provider: str | None = None
    text_model: str | None = None

    # Token limits
    max_input_tokens: int = 4000
    max_output_tokens: int = 4096

    # Chunking settings
    chunk_size: int = 500  # Target tokens per chunk
    chunk_overlap: int = 100  # Overlap tokens between chunks

    # Rate limiting
    rate_limit_enabled: bool = True
    max_concurrent_requests: int = 30
    requests_per_minute: int = 60
    tokens_per_minute: int = 150000
    batch_delay_ms: int = 100

    # Auto-load settings
    load_docs_on_startup: bool = False
    knowledge_path: str = "./docs"


@dataclass
class KnowledgeItem:
    """A knowledge item (document or fragment)."""

    id: str
    content: str
    metadata: dict[str, object] = field(default_factory=dict)
    embedding: list[float] | None = None
    similarity: float | None = None


@dataclass
class KnowledgeFragment:
    """A fragment of a larger document."""

    id: str
    document_id: str
    content: str
    position: int
    embedding: list[float] | None = None
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass
class KnowledgeDocument:
    """A complete document in the knowledge base."""

    id: str
    content: str
    filename: str
    content_type: str
    file_size: int
    fragments: list[KnowledgeFragment] = field(default_factory=list)
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass
class EmbeddingResult:
    """Result of an embedding generation."""

    embedding: list[float]
    tokens_used: int = 0
    model: str = ""


@dataclass
class SearchResult:
    """Result of a semantic search."""

    id: str
    content: str
    similarity: float
    document_id: str | None = None
    document_title: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass
class AddKnowledgeOptions:
    """Options for adding knowledge to the system."""

    content: str
    content_type: str
    filename: str
    agent_id: str | None = None
    world_id: str | None = None
    room_id: str | None = None
    entity_id: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass
class TextGenerationOptions:
    """Options for text generation."""

    provider: str | None = None
    model_name: str | None = None
    max_tokens: int | None = None
    cache_document: str | None = None
    cache_options: dict[str, str] | None = None
    auto_cache_contextual_retrieval: bool = True


@dataclass
class ProviderRateLimits:
    """Rate limit configuration for a provider."""

    max_concurrent_requests: int
    requests_per_minute: int
    tokens_per_minute: int | None = None
    provider: str = "unknown"
    rate_limit_enabled: bool = True
    batch_delay_ms: int = 100


@dataclass
class ChunkResult:
    """Result of chunking a document."""

    chunks: list[str]
    total_tokens: int = 0
    chunk_count: int = 0


@dataclass
class ProcessingResult:
    """Result of processing a document."""

    document_id: str
    fragment_count: int
    success: bool
    error: str | None = None
