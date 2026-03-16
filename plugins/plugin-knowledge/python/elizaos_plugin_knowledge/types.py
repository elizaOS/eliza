from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Sequence


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
    content_hash: str = ""
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


# ---------------------------------------------------------------------------
# RAG enrichment types – match TypeScript's RAG metadata structures
# ---------------------------------------------------------------------------


@dataclass
class RetrievedFragmentInfo:
    """Metadata about a single fragment retrieved during RAG."""

    fragment_id: str
    document_title: str
    similarity_score: float | None = None
    content_preview: str = ""


@dataclass
class RAGMetadata:
    """Full RAG retrieval metadata attached to a conversation memory."""

    retrieved_fragments: list[RetrievedFragmentInfo] = field(default_factory=list)
    query_text: str = ""
    total_fragments: int = 0
    retrieval_timestamp: int = 0
    used_in_response: bool = True


@dataclass
class PendingRAGEntry:
    """Internal bookkeeping for pending RAG enrichment."""

    rag_metadata: RAGMetadata = field(default_factory=RAGMetadata)
    timestamp: int = 0


# ---------------------------------------------------------------------------
# Contextual knowledge enrichment prompt constants (mirrors ctx-embeddings.ts)
# ---------------------------------------------------------------------------

DEFAULT_CHUNK_TOKEN_SIZE: int = 500
DEFAULT_CHUNK_OVERLAP_TOKENS: int = 100
DEFAULT_CHARS_PER_TOKEN: float = 3.5


@dataclass
class ContextTargets:
    min_tokens: int = 60
    max_tokens: int = 120


CONTEXT_TARGETS: dict[str, ContextTargets] = {
    "DEFAULT": ContextTargets(min_tokens=60, max_tokens=120),
    "PDF": ContextTargets(min_tokens=80, max_tokens=150),
    "MATH_PDF": ContextTargets(min_tokens=100, max_tokens=180),
    "CODE": ContextTargets(min_tokens=100, max_tokens=200),
    "TECHNICAL": ContextTargets(min_tokens=80, max_tokens=160),
}


CONTEXTUAL_CHUNK_ENRICHMENT_PROMPT_TEMPLATE: str = """
<document>
{doc_content}
</document>

Here is the chunk we want to situate within the whole document:
<chunk>
{chunk_content}
</chunk>

Create an enriched version of this chunk by adding critical surrounding context. Follow these guidelines:

1. Identify the document's main topic and key information relevant to understanding this chunk
2. Include 2-3 sentences before the chunk that provide essential context
3. Include 2-3 sentences after the chunk that complete thoughts or provide resolution
4. For technical documents, include any definitions or explanations of terms used in the chunk
5. For narrative content, include character or setting information needed to understand the chunk
6. Keep the original chunk text COMPLETELY INTACT and UNCHANGED in your response
7. Do not use phrases like "this chunk discusses" - directly present the context
8. The total length should be between {min_tokens} and {max_tokens} tokens
9. Format the response as a single coherent paragraph

Provide ONLY the enriched chunk text in your response:"""


# ---------------------------------------------------------------------------
# Document metadata (matching TypeScript KnowledgeDocumentMetadata)
# ---------------------------------------------------------------------------


@dataclass
class KnowledgeDocumentMetadata:
    type: str = "document"
    source: str = "upload"
    title: str | None = None
    filename: str | None = None
    file_ext: str | None = None
    file_type: str | None = None
    file_size: int | None = None


@dataclass
class FragmentMetadata:
    type: str = "fragment"
    document_id: str = ""
    position: int = 0
    timestamp: int = 0
    source: str = "rag-service-fragment"


# ---------------------------------------------------------------------------
# Knowledge service config type used by the TS config module
# ---------------------------------------------------------------------------


@dataclass
class KnowledgeServiceConfig:
    ctx_knowledge_enabled: bool = False
    load_docs_on_startup: bool = False
    max_input_tokens: int = 4000
    max_output_tokens: int = 4096
    embedding_provider: str | None = None
    text_provider: str | None = None
    text_embedding_model: str | None = None
    rate_limit_enabled: bool = True
    max_concurrent_requests: int = 100
    requests_per_minute: int = 500
    tokens_per_minute: int = 1000000
    batch_delay_ms: int = 100


# ---------------------------------------------------------------------------
# Extended memory metadata (matching TypeScript ExtendedMemoryMetadata)
# ---------------------------------------------------------------------------


@dataclass
class ExtendedMemoryMetadata:
    type: str | None = None
    title: str | None = None
    filename: str | None = None
    path: str | None = None
    description: str | None = None
    file_ext: str | None = None
    timestamp: int | None = None
    content_type: str | None = None
    document_id: str | None = None
    source: str | None = None
    file_type: str | None = None
    file_size: int | None = None
    position: int | None = None
    original_filename: str | None = None
    url: str | None = None


# ---------------------------------------------------------------------------
# Load result (matching TypeScript LoadResult)
# ---------------------------------------------------------------------------


@dataclass
class LoadResult:
    successful: int = 0
    failed: int = 0
    errors: list[dict[str, str]] | None = None
