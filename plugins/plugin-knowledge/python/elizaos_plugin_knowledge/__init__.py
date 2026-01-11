"""
elizaOS Knowledge Plugin - Python Implementation

Provides Retrieval Augmented Generation (RAG) capabilities including:
- Document processing and text extraction
- Text chunking with semantic awareness
- Embedding generation via multiple providers
- Semantic search and knowledge retrieval
"""

from elizaos_plugin_knowledge.types import (
    KnowledgeConfig,
    KnowledgeItem,
    KnowledgeFragment,
    KnowledgeDocument,
    EmbeddingResult,
    SearchResult,
    AddKnowledgeOptions,
    TextGenerationOptions,
    ProviderRateLimits,
)
from elizaos_plugin_knowledge.service import KnowledgeService
from elizaos_plugin_knowledge.provider import KnowledgeProvider, DocumentsProvider
from elizaos_plugin_knowledge.plugin import (
    KnowledgePlugin,
    create_knowledge_plugin,
    get_knowledge_plugin,
)

__version__ = "1.6.1"
__all__ = [
    # Types
    "KnowledgeConfig",
    "KnowledgeItem",
    "KnowledgeFragment",
    "KnowledgeDocument",
    "EmbeddingResult",
    "SearchResult",
    "AddKnowledgeOptions",
    "TextGenerationOptions",
    "ProviderRateLimits",
    # Service
    "KnowledgeService",
    # Providers
    "KnowledgeProvider",
    "DocumentsProvider",
    # Plugin
    "KnowledgePlugin",
    "create_knowledge_plugin",
    "get_knowledge_plugin",
]



