from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_knowledge.service import KnowledgeService

logger = logging.getLogger(__name__)


class KnowledgeProvider:
    name = "knowledge"
    description = "Provides relevant knowledge from the knowledge base"

    def __init__(self, service: KnowledgeService) -> None:
        self._service = service

    async def get_context(
        self,
        message: str,
        count: int = 5,
    ) -> str:
        if not message or not message.strip():
            return ""

        try:
            items = await self._service.get_knowledge(message, count=count)

            if not items:
                return ""

            context_parts: list[str] = []

            for i, item in enumerate(items, 1):
                similarity_pct = int((item.similarity or 0) * 100)
                context_parts.append(
                    f"[Knowledge {i}] (relevance: {similarity_pct}%)\n{item.content}"
                )

            return "\n\n---\n\n".join(context_parts)

        except Exception as e:
            logger.error(f"Error getting knowledge context: {e}")
            return ""


class DocumentsProvider:
    name = "documents"
    description = "Provides list of knowledge documents"

    def __init__(self, service: KnowledgeService) -> None:
        self._service = service

    async def get_documents(self) -> list[dict]:
        try:
            documents = self._service.get_documents()

            return [
                {
                    "id": doc.id,
                    "filename": doc.filename,
                    "content_type": doc.content_type,
                    "file_size": doc.file_size,
                    "fragment_count": len(doc.fragments),
                    "metadata": doc.metadata,
                }
                for doc in documents
            ]

        except Exception as e:
            logger.error(f"Error getting documents: {e}")
            return []

    async def get_document(self, document_id: str) -> dict | None:
        try:
            doc = self._service.get_document(document_id)
            if not doc:
                return None

            return {
                "id": doc.id,
                "filename": doc.filename,
                "content": doc.content,
                "content_type": doc.content_type,
                "file_size": doc.file_size,
                "fragments": [
                    {
                        "id": f.id,
                        "content": f.content,
                        "position": f.position,
                    }
                    for f in doc.fragments
                ],
                "metadata": doc.metadata,
            }

        except Exception as e:
            logger.error(f"Error getting document: {e}")
            return None


class KnowledgeProviderTs(KnowledgeProvider):
    """TS-parity alias provider (name: `KNOWLEDGE`)."""

    name = "KNOWLEDGE"
    description = (
        "Knowledge from the knowledge base that the agent knows, retrieved whenever the agent needs "
        "to answer a question about their expertise."
    )


class AvailableDocumentsProvider(DocumentsProvider):
    """TS-parity alias provider (name: `AVAILABLE_DOCUMENTS`)."""

    name = "AVAILABLE_DOCUMENTS"
    description = (
        "List of documents available in the knowledge base. Shows which documents the agent can "
        "reference and retrieve information from."
    )
