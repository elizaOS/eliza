from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from elizaos_plugin_knowledge.types import RAGMetadata, RetrievedFragmentInfo

if TYPE_CHECKING:
    from elizaos_plugin_knowledge.service import KnowledgeService

logger = logging.getLogger(__name__)


class KnowledgeProvider:
    """Provides relevant knowledge from the knowledge base with RAG metadata.

    Mirrors the TypeScript ``knowledgeProvider`` – retrieves knowledge fragments,
    formats them for the LLM context, and produces RAG metadata for enrichment.
    """

    name = "knowledge"
    description = "Provides relevant knowledge from the knowledge base"

    def __init__(self, service: KnowledgeService) -> None:
        self._service = service

    async def get_context(
        self,
        message: str,
        count: int = 5,
    ) -> str:
        """Get formatted knowledge context for a message.

        Returns a formatted string of knowledge items suitable for LLM context.
        """
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

    async def get(
        self,
        message: str,
        count: int = 5,
    ) -> dict:
        """Get knowledge context with full RAG metadata.

        Mirrors the TypeScript provider's ``get`` method which returns data,
        values, text, ragMetadata, and knowledgeUsed.
        """
        if not message or not message.strip():
            return {
                "data": {"knowledge": "", "ragMetadata": None, "knowledgeUsed": False},
                "values": {"knowledge": "", "knowledgeUsed": False},
                "text": "",
                "ragMetadata": None,
                "knowledgeUsed": False,
            }

        try:
            items = await self._service.get_knowledge(message, count=count)
            first_five = items[:5] if items else []

            # Build knowledge text
            if first_five:
                knowledge_items_text = "\n".join(f"- {item.content}" for item in first_five)
                knowledge = f"# Knowledge\n\n{knowledge_items_text}\n"
            else:
                knowledge = ""

            # Truncate if too long (4000 tokens * ~3.5 chars/token)
            max_chars = int(4000 * 3.5)
            if len(knowledge) > max_chars:
                knowledge = knowledge[:max_chars]

            # Build RAG metadata
            rag_metadata: dict | None = None
            if items:
                rag_metadata_obj = self._service.build_rag_metadata(items, message)
                rag_metadata = {
                    "retrievedFragments": [
                        {
                            "fragmentId": f.fragment_id,
                            "documentTitle": f.document_title,
                            "similarityScore": f.similarity_score,
                            "contentPreview": f.content_preview,
                        }
                        for f in rag_metadata_obj.retrieved_fragments
                    ],
                    "queryText": rag_metadata_obj.query_text,
                    "totalFragments": rag_metadata_obj.total_fragments,
                    "retrievalTimestamp": rag_metadata_obj.retrieval_timestamp,
                }

                # Queue for enrichment (like TypeScript's setPendingRAGMetadata)
                self._service.set_pending_rag_metadata(rag_metadata_obj)

            knowledge_used = bool(items)

            return {
                "data": {
                    "knowledge": knowledge,
                    "ragMetadata": rag_metadata,
                    "knowledgeUsed": knowledge_used,
                },
                "values": {
                    "knowledge": knowledge,
                    "knowledgeUsed": knowledge_used,
                },
                "text": knowledge,
                "ragMetadata": rag_metadata,
                "knowledgeUsed": knowledge_used,
            }

        except Exception as e:
            logger.error(f"Error in knowledge provider get: {e}")
            return {
                "data": {"knowledge": "", "ragMetadata": None, "knowledgeUsed": False},
                "values": {"knowledge": "", "knowledgeUsed": False},
                "text": "",
                "ragMetadata": None,
                "knowledgeUsed": False,
            }


class DocumentsProvider:
    """Provides list of knowledge documents."""

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
    """TS-parity alias provider (name: ``KNOWLEDGE``)."""

    name = "KNOWLEDGE"
    description = (
        "Knowledge from the knowledge base that the agent knows, retrieved whenever the agent needs "
        "to answer a question about their expertise."
    )


class AvailableDocumentsProvider(DocumentsProvider):
    """TS-parity alias provider (name: ``AVAILABLE_DOCUMENTS``)."""

    name = "AVAILABLE_DOCUMENTS"
    description = (
        "List of documents available in the knowledge base. Shows which documents the agent can "
        "reference and retrieve information from."
    )
