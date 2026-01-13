from __future__ import annotations

import logging

from elizaos_plugin_knowledge.service import KnowledgeService
from elizaos_plugin_knowledge.provider import (
    AvailableDocumentsProvider,
    DocumentsProvider,
    KnowledgeProvider,
    KnowledgeProviderTs,
)
from elizaos_plugin_knowledge.types import (
    AddKnowledgeOptions,
    KnowledgeConfig,
    KnowledgeItem,
    ProcessingResult,
    SearchResult,
)

logger = logging.getLogger(__name__)

_plugin_instance: KnowledgePlugin | None = None


class KnowledgePlugin:
    name = "knowledge"
    description = "Provides knowledge management and RAG capabilities"
    version = "1.6.1"

    def __init__(
        self,
        config: KnowledgeConfig | None = None,
    ) -> None:
        self._config = config or KnowledgeConfig()
        self._service = KnowledgeService(config=self._config)
        self._knowledge_provider = KnowledgeProvider(self._service)
        self._knowledge_provider_ts = KnowledgeProviderTs(self._service)
        self._documents_provider = DocumentsProvider(self._service)
        self._available_documents_provider = AvailableDocumentsProvider(self._service)
        self._initialized = False

    @property
    def service(self) -> KnowledgeService:
        return self._service

    @property
    def knowledge_provider(self) -> KnowledgeProvider:
        return self._knowledge_provider

    @property
    def documents_provider(self) -> DocumentsProvider:
        return self._documents_provider

    async def init(self) -> None:
        if self._initialized:
            return

        logger.info("Initializing Knowledge plugin...")

        if self._config.load_docs_on_startup:
            await self._load_startup_documents()

        self._initialized = True
        logger.info("Knowledge plugin initialized")

    async def _load_startup_documents(self) -> None:
        from pathlib import Path

        knowledge_path = Path(self._config.knowledge_path)

        if not knowledge_path.exists() or not knowledge_path.is_dir():
            return

        supported_extensions = {
            ".txt": "text/plain",
            ".md": "text/markdown",
            ".json": "application/json",
            ".pdf": "application/pdf",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }

        for file_path in knowledge_path.iterdir():
            if not file_path.is_file():
                continue

            ext = file_path.suffix.lower()
            if ext not in supported_extensions:
                continue

            try:
                content_type = supported_extensions[ext]

                if ext in [".pdf", ".docx"]:
                    import base64

                    with open(file_path, "rb") as f:
                        content = base64.b64encode(f.read()).decode()
                else:
                    with open(file_path, encoding="utf-8") as f:
                        content = f.read()

                options = AddKnowledgeOptions(
                    content=content,
                    content_type=content_type,
                    filename=file_path.name,
                )

                result = await self._service.add_knowledge(options)

                if result.success:
                    logger.info(f"Loaded '{file_path.name}' with {result.fragment_count} fragments")
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
        return await self._service.search(query, count=count, threshold=threshold)

    async def get_knowledge(
        self,
        query: str,
        count: int = 5,
    ) -> list[KnowledgeItem]:
        return await self._service.get_knowledge(query, count=count)

    async def delete_knowledge(self, document_id: str) -> bool:
        return await self._service.delete_knowledge(document_id)

    def get_providers(self) -> list[dict]:
        return [
            {
                "name": self._knowledge_provider.name,
                "description": self._knowledge_provider.description,
                "handler": self._knowledge_provider.get_context,
            },
            {
                "name": self._knowledge_provider_ts.name,
                "description": self._knowledge_provider_ts.description,
                "handler": self._knowledge_provider_ts.get_context,
            },
            {
                "name": self._documents_provider.name,
                "description": self._documents_provider.description,
                "handler": self._documents_provider.get_documents,
            },
            {
                "name": self._available_documents_provider.name,
                "description": self._available_documents_provider.description,
                "handler": self._available_documents_provider.get_documents,
            },
        ]

    def get_actions(self) -> list[dict]:
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
        document_id = params.get("document_id", "")
        success = await self.delete_knowledge(document_id)
        return {"success": success, "document_id": document_id}


def create_knowledge_plugin(
    config: KnowledgeConfig | None = None,
) -> KnowledgePlugin:
    global _plugin_instance
    _plugin_instance = KnowledgePlugin(config=config)
    return _plugin_instance


def get_knowledge_plugin() -> KnowledgePlugin | None:
    return _plugin_instance
