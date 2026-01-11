"""
Knowledge Plugin for elizaOS.

Provides Retrieval Augmented Generation (RAG) capabilities.
"""

from __future__ import annotations

import logging
from typing import Callable

from elizaos_plugin_knowledge.service import KnowledgeService
from elizaos_plugin_knowledge.provider import KnowledgeProvider, DocumentsProvider
from elizaos_plugin_knowledge.types import (
    AddKnowledgeOptions,
    KnowledgeConfig,
    KnowledgeItem,
    ProcessingResult,
    SearchResult,
)

logger = logging.getLogger(__name__)

# Global plugin instance
_plugin_instance: KnowledgePlugin | None = None


class KnowledgePlugin:
    """
    Knowledge Plugin - RAG capabilities for elizaOS.

    Provides:
    - Document processing and chunking
    - Embedding generation
    - Semantic search
    - Knowledge retrieval
    """

    name = "knowledge"
    description = "Provides knowledge management and RAG capabilities"
    version = "1.6.1"

    def __init__(
        self,
        config: KnowledgeConfig | None = None,
    ) -> None:
        """
        Initialize the Knowledge plugin.

        Args:
            config: Plugin configuration.
        """
        self._config = config or KnowledgeConfig()
        self._service = KnowledgeService(config=self._config)
        self._knowledge_provider = KnowledgeProvider(self._service)
        self._documents_provider = DocumentsProvider(self._service)
        self._initialized = False

    @property
    def service(self) -> KnowledgeService:
        """Get the knowledge service instance."""
        return self._service

    @property
    def knowledge_provider(self) -> KnowledgeProvider:
        """Get the knowledge provider."""
        return self._knowledge_provider

    @property
    def documents_provider(self) -> DocumentsProvider:
        """Get the documents provider."""
        return self._documents_provider

    async def init(self) -> None:
        """Initialize the plugin."""
        if self._initialized:
            return

        logger.info("Initializing Knowledge plugin...")

        # Auto-load documents if configured
        if self._config.load_docs_on_startup:
            await self._load_startup_documents()

        self._initialized = True
        logger.info("Knowledge plugin initialized")

    async def _load_startup_documents(self) -> None:
        """Load documents from the configured knowledge path."""
        import os
        from pathlib import Path

        knowledge_path = Path(self._config.knowledge_path)

        if not knowledge_path.exists():
            logger.debug(f"Knowledge path '{knowledge_path}' does not exist")
            return

        if not knowledge_path.is_dir():
            logger.warning(f"Knowledge path '{knowledge_path}' is not a directory")
            return

        # Supported file extensions
        supported_extensions = {
            ".txt": "text/plain",
            ".md": "text/markdown",
            ".json": "application/json",
            ".pdf": "application/pdf",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }

        # Process files
        for file_path in knowledge_path.iterdir():
            if not file_path.is_file():
                continue

            ext = file_path.suffix.lower()
            if ext not in supported_extensions:
                continue

            try:
                content_type = supported_extensions[ext]

                # Read file content
                if ext in [".pdf", ".docx"]:
                    # Binary files
                    import base64

                    with open(file_path, "rb") as f:
                        content = base64.b64encode(f.read()).decode()
                else:
                    # Text files
                    with open(file_path, encoding="utf-8") as f:
                        content = f.read()

                options = AddKnowledgeOptions(
                    content=content,
                    content_type=content_type,
                    filename=file_path.name,
                )

                result = await self._service.add_knowledge(options)

                if result.success:
                    logger.info(
                        f"Loaded '{file_path.name}' with {result.fragment_count} fragments"
                    )
                else:
                    logger.warning(f"Failed to load '{file_path.name}': {result.error}")

            except Exception as e:
                logger.error(f"Error loading '{file_path.name}': {e}")

    async def add_knowledge(
        self,
        content: str,
        content_type: str,
        filename: str,
        **kwargs,
    ) -> ProcessingResult:
        """
        Add knowledge to the system.

        Args:
            content: The document content.
            content_type: MIME type of the content.
            filename: Original filename.
            **kwargs: Additional options.

        Returns:
            ProcessingResult with document ID and status.
        """
        options = AddKnowledgeOptions(
            content=content,
            content_type=content_type,
            filename=filename,
            agent_id=kwargs.get("agent_id"),
            world_id=kwargs.get("world_id"),
            room_id=kwargs.get("room_id"),
            entity_id=kwargs.get("entity_id"),
            metadata=kwargs.get("metadata", {}),
        )
        return await self._service.add_knowledge(options)

    async def search(
        self,
        query: str,
        count: int = 10,
        threshold: float = 0.1,
    ) -> list[SearchResult]:
        """
        Search for relevant knowledge.

        Args:
            query: Search query.
            count: Maximum results.
            threshold: Minimum similarity threshold.

        Returns:
            List of search results.
        """
        return await self._service.search(query, count=count, threshold=threshold)

    async def get_knowledge(
        self,
        query: str,
        count: int = 5,
    ) -> list[KnowledgeItem]:
        """
        Get knowledge items relevant to a query.

        Args:
            query: Query text.
            count: Maximum items to return.

        Returns:
            List of knowledge items.
        """
        return await self._service.get_knowledge(query, count=count)

    async def delete_knowledge(self, document_id: str) -> bool:
        """
        Delete a knowledge document.

        Args:
            document_id: ID of the document to delete.

        Returns:
            True if deleted, False otherwise.
        """
        return await self._service.delete_knowledge(document_id)

    def get_providers(self) -> list[dict]:
        """Get the plugin's providers."""
        return [
            {
                "name": self._knowledge_provider.name,
                "description": self._knowledge_provider.description,
                "handler": self._knowledge_provider.get_context,
            },
            {
                "name": self._documents_provider.name,
                "description": self._documents_provider.description,
                "handler": self._documents_provider.get_documents,
            },
        ]

    def get_actions(self) -> list[dict]:
        """Get the plugin's actions."""
        return [
            {
                "name": "add-knowledge",
                "description": "Add a document to the knowledge base",
                "handler": self._handle_add_knowledge,
            },
            {
                "name": "search-knowledge",
                "description": "Search the knowledge base",
                "handler": self._handle_search,
            },
            {
                "name": "delete-knowledge",
                "description": "Delete a document from the knowledge base",
                "handler": self._handle_delete,
            },
        ]

    async def _handle_add_knowledge(self, params: dict) -> dict:
        """Handle add-knowledge action."""
        result = await self.add_knowledge(
            content=params.get("content", ""),
            content_type=params.get("content_type", "text/plain"),
            filename=params.get("filename", "unknown"),
            **params,
        )
        return {
            "success": result.success,
            "document_id": result.document_id,
            "fragment_count": result.fragment_count,
            "error": result.error,
        }

    async def _handle_search(self, params: dict) -> dict:
        """Handle search-knowledge action."""
        results = await self.search(
            query=params.get("query", ""),
            count=params.get("count", 10),
            threshold=params.get("threshold", 0.1),
        )
        return {
            "results": [
                {
                    "id": r.id,
                    "content": r.content,
                    "similarity": r.similarity,
                    "document_id": r.document_id,
                }
                for r in results
            ]
        }

    async def _handle_delete(self, params: dict) -> dict:
        """Handle delete-knowledge action."""
        document_id = params.get("document_id", "")
        success = await self.delete_knowledge(document_id)
        return {"success": success, "document_id": document_id}


def create_knowledge_plugin(
    config: KnowledgeConfig | None = None,
) -> KnowledgePlugin:
    """
    Create a new Knowledge plugin instance.

    Args:
        config: Plugin configuration.

    Returns:
        New KnowledgePlugin instance.
    """
    global _plugin_instance
    _plugin_instance = KnowledgePlugin(config=config)
    return _plugin_instance


def get_knowledge_plugin() -> KnowledgePlugin | None:
    """
    Get the current Knowledge plugin instance.

    Returns:
        Current plugin instance or None.
    """
    return _plugin_instance



