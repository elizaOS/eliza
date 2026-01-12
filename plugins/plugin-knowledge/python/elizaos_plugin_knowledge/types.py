from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class MemoryType(str, Enum):
    """Type of memory for knowledge fragments and documents."""

    DOCUMENT = "document"
    FRAGMENT = "fragment"
    MESSAGE = "message"
    DESCRIPTION = "description"
    CUSTOM = "custom"


class EmbeddingProvider(str, Enum):
    OPENAI = "openai"
    GOOGLE = "google"


class TextProvider(str, Enum):
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    OPENROUTER = "openrouter"
    GOOGLE = "google"


@dataclass
class KnowledgeConfig:
    embedding_provider: str = "openai"
    embedding_model: str = "text-embedding-3-small"
    embedding_dimension: int = 1536

    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    google_api_key: str | None = None
    openrouter_api_key: str | None = None

    openai_base_url: str | None = None
    anthropic_base_url: str | None = None
    google_base_url: str | None = None
    openrouter_base_url: str | None = None

    ctx_knowledge_enabled: bool = False
    text_provider: str | None = None
    text_model: str | None = None

    max_input_tokens: int = 4000
    max_output_tokens: int = 4096

    chunk_size: int = 500
    chunk_overlap: int = 100

    rate_limit_enabled: bool = True
    max_concurrent_requests: int = 30
    requests_per_minute: int = 60
    tokens_per_minute: int = 150000
    batch_delay_ms: int = 100

    load_docs_on_startup: bool = False
    knowledge_path: str = "./docs"


@dataclass
class KnowledgeItem:
    id: str
    content: str
    metadata: dict[str, object] = field(default_factory=dict)
    embedding: list[float] | None = None
    similarity: float | None = None


@dataclass
class KnowledgeFragment:
    id: str
    document_id: str
    content: str
    position: int
    embedding: list[float] | None = None
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass
class KnowledgeDocument:
    id: str
    content: str
    filename: str
    content_type: str
    file_size: int
    fragments: list[KnowledgeFragment] = field(default_factory=list)
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass
class EmbeddingResult:
    embedding: list[float]
    tokens_used: int = 0
    model: str = ""


@dataclass
class SearchResult:
    id: str
    content: str
    similarity: float
    document_id: str | None = None
    document_title: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass
class AddKnowledgeOptions:
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
    provider: str | None = None
    model_name: str | None = None
    max_tokens: int | None = None
    cache_document: str | None = None
    cache_options: dict[str, str] | None = None
    auto_cache_contextual_retrieval: bool = True


@dataclass
class ProviderRateLimits:
    max_concurrent_requests: int
    requests_per_minute: int
    tokens_per_minute: int | None = None
    provider: str = "unknown"
    rate_limit_enabled: bool = True
    batch_delay_ms: int = 100


@dataclass
class ChunkResult:
    chunks: list[str]
    total_tokens: int = 0
    chunk_count: int = 0


@dataclass
class ProcessingResult:
    document_id: str
    fragment_count: int
    success: bool
    error: str | None = None
