from __future__ import annotations

import hashlib
import logging
import os
import uuid
from typing import Protocol

from elizaos_plugin_knowledge.types import (
    AddKnowledgeOptions,
    ChunkResult,
    EmbeddingResult,
    KnowledgeConfig,
    KnowledgeDocument,
    KnowledgeFragment,
    KnowledgeItem,
    MemoryType,
    ProcessingResult,
    SearchResult,
)

logger = logging.getLogger(__name__)

DEFAULT_CHUNK_SIZE = 500
DEFAULT_CHUNK_OVERLAP = 100
CHARS_PER_TOKEN = 3.5


class EmbeddingProvider(Protocol):
    async def generate_embedding(self, text: str) -> EmbeddingResult: ...

    async def generate_embeddings_batch(self, texts: list[str]) -> list[EmbeddingResult]: ...


class MemoryStore(Protocol):
    async def create_memory(self, memory: dict) -> str: ...

    async def get_memory_by_id(self, memory_id: str) -> dict | None: ...

    async def search_memories(
        self,
        embedding: list[float],
        count: int = 10,
        threshold: float = 0.1,
    ) -> list[dict]: ...

    async def delete_memory(self, memory_id: str) -> None: ...


class KnowledgeService:
    def __init__(
        self,
        config: KnowledgeConfig | None = None,
        embedding_provider: EmbeddingProvider | None = None,
        memory_store: MemoryStore | None = None,
    ) -> None:
        self.config = config or KnowledgeConfig()
        self._embedding_provider = embedding_provider
        self._memory_store = memory_store
        self._documents: dict[str, KnowledgeDocument] = {}
        self._fragments: dict[str, KnowledgeFragment] = {}

        self._load_env_config()

    def _load_env_config(self) -> None:
        env_mappings = {
            "EMBEDDING_PROVIDER": "embedding_provider",
            "TEXT_EMBEDDING_MODEL": "embedding_model",
            "EMBEDDING_DIMENSION": ("embedding_dimension", int),
            "OPENAI_API_KEY": "openai_api_key",
            "ANTHROPIC_API_KEY": "anthropic_api_key",
            "GOOGLE_API_KEY": "google_api_key",
            "OPENROUTER_API_KEY": "openrouter_api_key",
            "CTX_KNOWLEDGE_ENABLED": ("ctx_knowledge_enabled", lambda x: x.lower() == "true"),
            "TEXT_PROVIDER": "text_provider",
            "TEXT_MODEL": "text_model",
            "MAX_INPUT_TOKENS": ("max_input_tokens", int),
            "MAX_OUTPUT_TOKENS": ("max_output_tokens", int),
            "KNOWLEDGE_PATH": "knowledge_path",
            "LOAD_DOCS_ON_STARTUP": ("load_docs_on_startup", lambda x: x.lower() != "false"),
        }

        for env_key, attr in env_mappings.items():
            value = os.environ.get(env_key)
            if value is not None:
                if isinstance(attr, tuple):
                    attr_name, converter = attr
                    setattr(self.config, attr_name, converter(value))
                else:
                    setattr(self.config, attr, value)

    def _generate_content_id(
        self,
        content: str,
        agent_id: str,
        filename: str | None = None,
    ) -> str:
        content_for_hash = content[:2000].strip()

        content_for_hash = " ".join(content_for_hash.split())

        components = [agent_id, content_for_hash]
        if filename:
            components.append(filename)

        hash_input = "::".join(components)
        content_hash = hashlib.sha256(hash_input.encode()).hexdigest()

        namespace = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
        return str(uuid.uuid5(namespace, content_hash))

    def _split_into_chunks(
        self,
        text: str,
        chunk_size: int | None = None,
        overlap: int | None = None,
    ) -> ChunkResult:
        chunk_size = chunk_size or self.config.chunk_size
        overlap = overlap or self.config.chunk_overlap

        char_chunk_size = int(chunk_size * CHARS_PER_TOKEN)
        char_overlap = int(overlap * CHARS_PER_TOKEN)

        chunks: list[str] = []
        start = 0
        text_len = len(text)

        while start < text_len:
            end = min(start + char_chunk_size, text_len)

            if end < text_len:
                search_start = start + int(char_chunk_size * 0.8)
                for i in range(end, search_start, -1):
                    if text[i] in ".!?\n":
                        end = i + 1
                        break

            chunk = text[start:end].strip()
            if chunk:
                chunks.append(chunk)

            # Break if we've reached the end of the text
            if end >= text_len:
                break

            # Move start with overlap, ensuring forward progress
            new_start = end - char_overlap
            if new_start <= start:
                # Ensure we always make forward progress
                start = end
            else:
                start = new_start

        return ChunkResult(
            chunks=chunks,
            chunk_count=len(chunks),
            total_tokens=int(len(text) / CHARS_PER_TOKEN),
        )

    async def add_knowledge(
        self,
        options: AddKnowledgeOptions,
    ) -> ProcessingResult:
        agent_id = options.agent_id or "default"

        document_id = self._generate_content_id(
            options.content,
            agent_id,
            options.filename,
        )

        if document_id in self._documents:
            existing = self._documents[document_id]
            return ProcessingResult(
                document_id=document_id,
                fragment_count=len(existing.fragments),
                success=True,
            )

        try:
            text_content = await self._extract_text(
                options.content,
                options.content_type,
                options.filename,
            )

            if not text_content or not text_content.strip():
                return ProcessingResult(
                    document_id=document_id,
                    fragment_count=0,
                    success=False,
                    error="No text content extracted",
                )

            document = KnowledgeDocument(
                id=document_id,
                content=text_content,
                filename=options.filename,
                content_type=options.content_type,
                file_size=len(options.content),
                metadata={
                    "type": MemoryType.DOCUMENT.value,
                    "source": "knowledge-service",
                    **options.metadata,
                },
            )

            chunk_result = self._split_into_chunks(text_content)

            fragments: list[KnowledgeFragment] = []
            for i, chunk in enumerate(chunk_result.chunks):
                fragment_id = f"{document_id}-{i}"
                fragment = KnowledgeFragment(
                    id=fragment_id,
                    document_id=document_id,
                    content=chunk,
                    position=i,
                    metadata={
                        "type": MemoryType.FRAGMENT.value,
                        "document_id": document_id,
                        "position": i,
                    },
                )
                fragments.append(fragment)
                self._fragments[fragment_id] = fragment

            document.fragments = fragments
            self._documents[document_id] = document

            if self._embedding_provider:
                await self._generate_fragment_embeddings(fragments)

            logger.info(f"Added document '{options.filename}' with {len(fragments)} fragments")

            return ProcessingResult(
                document_id=document_id,
                fragment_count=len(fragments),
                success=True,
            )

        except Exception as e:
            logger.error(f"Error adding knowledge: {e}")
            return ProcessingResult(
                document_id=document_id,
                fragment_count=0,
                success=False,
                error=str(e),
            )

    async def _extract_text(
        self,
        content: str,
        content_type: str,
        filename: str,
    ) -> str:
        if content_type.startswith("text/") or content_type in [
            "application/json",
            "application/xml",
        ]:
            return content

        if content_type == "application/pdf" or filename.lower().endswith(".pdf"):
            return await self._extract_pdf_text(content)

        if "wordprocessingml" in content_type or filename.lower().endswith(".docx"):
            return await self._extract_docx_text(content)

        return content

    async def _extract_pdf_text(self, content: str) -> str:
        try:
            import base64
            from pypdf import PdfReader
            from io import BytesIO

            if self._looks_like_base64(content):
                pdf_bytes = base64.b64decode(content)
            else:
                pdf_bytes = content.encode()

            reader = PdfReader(BytesIO(pdf_bytes))
            text_parts: list[str] = []
            for page in reader.pages:
                text = page.extract_text()
                if text:
                    text_parts.append(text)

            return "\n\n".join(text_parts)
        except ImportError:
            raise

    async def _extract_docx_text(self, content: str) -> str:
        try:
            import base64
            from docx import Document
            from io import BytesIO

            if self._looks_like_base64(content):
                docx_bytes = base64.b64decode(content)
            else:
                docx_bytes = content.encode()

            doc = Document(BytesIO(docx_bytes))
            text_parts: list[str] = []
            for para in doc.paragraphs:
                if para.text:
                    text_parts.append(para.text)

            return "\n\n".join(text_parts)
        except ImportError:
            raise

    def _looks_like_base64(self, content: str) -> bool:
        if len(content) < 16:
            return False
        clean = content.replace(" ", "").replace("\n", "")
        if len(clean) % 4 != 0:
            return False
        import re

        return bool(re.match(r"^[A-Za-z0-9+/]*={0,2}$", clean))

    async def _generate_fragment_embeddings(
        self,
        fragments: list[KnowledgeFragment],
    ) -> None:
        if not self._embedding_provider:
            return

        texts = [f.content for f in fragments]
        results = await self._embedding_provider.generate_embeddings_batch(texts)

        for fragment, result in zip(fragments, results):
            fragment.embedding = result.embedding

    async def search(
        self,
        query: str,
        count: int = 10,
        threshold: float = 0.1,
    ) -> list[SearchResult]:
        if not self._embedding_provider:
            logger.warning("No embedding provider configured for search")
            return []

        result = await self._embedding_provider.generate_embedding(query)
        query_embedding = result.embedding

        results: list[SearchResult] = []

        for fragment in self._fragments.values():
            if fragment.embedding is None:
                continue

            similarity = self._cosine_similarity(
                query_embedding,
                fragment.embedding,
            )

            if similarity >= threshold:
                document = self._documents.get(fragment.document_id)
                results.append(
                    SearchResult(
                        id=fragment.id,
                        content=fragment.content,
                        similarity=similarity,
                        document_id=fragment.document_id,
                        document_title=document.filename if document else None,
                        metadata=fragment.metadata,
                    )
                )

        results.sort(key=lambda x: x.similarity, reverse=True)
        return results[:count]

    def _cosine_similarity(
        self,
        vec1: list[float],
        vec2: list[float],
    ) -> float:
        import math

        dot_product = sum(a * b for a, b in zip(vec1, vec2))
        norm1 = math.sqrt(sum(a * a for a in vec1))
        norm2 = math.sqrt(sum(b * b for b in vec2))

        if norm1 == 0 or norm2 == 0:
            return 0.0

        return dot_product / (norm1 * norm2)

    async def get_knowledge(
        self,
        query: str,
        count: int = 5,
    ) -> list[KnowledgeItem]:
        results = await self.search(query, count=count)

        return [
            KnowledgeItem(
                id=r.id,
                content=r.content,
                similarity=r.similarity,
                metadata=r.metadata,
            )
            for r in results
        ]

    async def delete_knowledge(self, document_id: str) -> bool:
        if document_id not in self._documents:
            return False

        document = self._documents[document_id]

        # Delete fragments
        for fragment in document.fragments:
            self._fragments.pop(fragment.id, None)

        del self._documents[document_id]

        logger.info(f"Deleted document {document_id}")
        return True

    def get_documents(self) -> list[KnowledgeDocument]:
        return list(self._documents.values())

    def get_document(self, document_id: str) -> KnowledgeDocument | None:
        return self._documents.get(document_id)
