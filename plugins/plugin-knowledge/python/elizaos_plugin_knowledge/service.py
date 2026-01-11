"""
Knowledge Service - Core RAG functionality.

Provides document processing, embedding generation, and semantic search.
"""

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

# Default chunking parameters
DEFAULT_CHUNK_SIZE = 500  # tokens
DEFAULT_CHUNK_OVERLAP = 100  # tokens
CHARS_PER_TOKEN = 3.5  # approximate


class EmbeddingProvider(Protocol):
    """Protocol for embedding providers."""

    async def generate_embedding(self, text: str) -> EmbeddingResult:
        """Generate an embedding for the given text."""
        ...

    async def generate_embeddings_batch(
        self, texts: list[str]
    ) -> list[EmbeddingResult]:
        """Generate embeddings for multiple texts."""
        ...


class MemoryStore(Protocol):
    """Protocol for memory storage."""

    async def create_memory(self, memory: dict) -> str:
        """Create a memory and return its ID."""
        ...

    async def get_memory_by_id(self, memory_id: str) -> dict | None:
        """Get a memory by ID."""
        ...

    async def search_memories(
        self,
        embedding: list[float],
        count: int = 10,
        threshold: float = 0.1,
    ) -> list[dict]:
        """Search memories by embedding similarity."""
        ...

    async def delete_memory(self, memory_id: str) -> None:
        """Delete a memory."""
        ...


class KnowledgeService:
    """
    Knowledge Service - Provides RAG capabilities.

    Handles document processing, embedding generation, and semantic search.
    """

    def __init__(
        self,
        config: KnowledgeConfig | None = None,
        embedding_provider: EmbeddingProvider | None = None,
        memory_store: MemoryStore | None = None,
    ) -> None:
        """
        Initialize the Knowledge service.

        Args:
            config: Service configuration.
            embedding_provider: Provider for generating embeddings.
            memory_store: Storage for knowledge items.
        """
        self.config = config or KnowledgeConfig()
        self._embedding_provider = embedding_provider
        self._memory_store = memory_store
        self._documents: dict[str, KnowledgeDocument] = {}
        self._fragments: dict[str, KnowledgeFragment] = {}

        # Load config from environment if not provided
        self._load_env_config()

    def _load_env_config(self) -> None:
        """Load configuration from environment variables."""
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
        """
        Generate a deterministic ID based on content.

        Args:
            content: Document content.
            agent_id: Agent ID for namespacing.
            filename: Optional filename for uniqueness.

        Returns:
            A deterministic UUID string.
        """
        # Use first 2000 chars for ID generation
        content_for_hash = content[:2000].strip()

        # Normalize whitespace
        content_for_hash = " ".join(content_for_hash.split())

        # Create hash components
        components = [agent_id, content_for_hash]
        if filename:
            components.append(filename)

        hash_input = "::".join(components)
        content_hash = hashlib.sha256(hash_input.encode()).hexdigest()

        # Generate UUID v5 from hash
        namespace = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
        return str(uuid.uuid5(namespace, content_hash))

    def _split_into_chunks(
        self,
        text: str,
        chunk_size: int | None = None,
        overlap: int | None = None,
    ) -> ChunkResult:
        """
        Split text into semantic chunks.

        Args:
            text: Text to split.
            chunk_size: Target tokens per chunk.
            overlap: Overlap tokens between chunks.

        Returns:
            ChunkResult with list of chunks.
        """
        chunk_size = chunk_size or self.config.chunk_size
        overlap = overlap or self.config.chunk_overlap

        # Convert token targets to character estimates
        char_chunk_size = int(chunk_size * CHARS_PER_TOKEN)
        char_overlap = int(overlap * CHARS_PER_TOKEN)

        chunks: list[str] = []
        start = 0
        text_len = len(text)

        while start < text_len:
            end = min(start + char_chunk_size, text_len)

            # Try to break at sentence boundary
            if end < text_len:
                # Look for sentence end within last 20% of chunk
                search_start = start + int(char_chunk_size * 0.8)
                for i in range(end, search_start, -1):
                    if text[i] in ".!?\n":
                        end = i + 1
                        break

            chunk = text[start:end].strip()
            if chunk:
                chunks.append(chunk)

            # Move start with overlap
            start = end - char_overlap
            if start >= text_len:
                break

        return ChunkResult(
            chunks=chunks,
            chunk_count=len(chunks),
            total_tokens=int(len(text) / CHARS_PER_TOKEN),
        )

    async def add_knowledge(
        self,
        options: AddKnowledgeOptions,
    ) -> ProcessingResult:
        """
        Add knowledge to the system.

        Args:
            options: Options for adding knowledge.

        Returns:
            ProcessingResult with document ID and fragment count.
        """
        agent_id = options.agent_id or "default"

        # Generate content-based ID
        document_id = self._generate_content_id(
            options.content,
            agent_id,
            options.filename,
        )

        # Check if document already exists
        if document_id in self._documents:
            existing = self._documents[document_id]
            return ProcessingResult(
                document_id=document_id,
                fragment_count=len(existing.fragments),
                success=True,
            )

        try:
            # Extract text if needed (for binary files)
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

            # Create document
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

            # Split into chunks
            chunk_result = self._split_into_chunks(text_content)

            # Create fragments
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

            # Generate embeddings if provider is available
            if self._embedding_provider:
                await self._generate_fragment_embeddings(fragments)

            logger.info(
                f"Added document '{options.filename}' with {len(fragments)} fragments"
            )

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
        """
        Extract text from content based on type.

        Args:
            content: Raw content (may be base64 for binary files).
            content_type: MIME type.
            filename: Original filename.

        Returns:
            Extracted text content.
        """
        # For text types, content is already text
        if content_type.startswith("text/") or content_type in [
            "application/json",
            "application/xml",
        ]:
            return content

        # For PDF files
        if content_type == "application/pdf" or filename.lower().endswith(".pdf"):
            return await self._extract_pdf_text(content)

        # For DOCX files
        if "wordprocessingml" in content_type or filename.lower().endswith(".docx"):
            return await self._extract_docx_text(content)

        # Default: try to decode as text
        return content

    async def _extract_pdf_text(self, content: str) -> str:
        """Extract text from PDF content."""
        try:
            import base64

            from pypdf import PdfReader
            from io import BytesIO

            # Decode base64 if needed
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
            logger.warning("pypdf not installed, cannot extract PDF text")
            return content
        except Exception as e:
            logger.error(f"Error extracting PDF text: {e}")
            return content

    async def _extract_docx_text(self, content: str) -> str:
        """Extract text from DOCX content."""
        try:
            import base64

            from docx import Document
            from io import BytesIO

            # Decode base64 if needed
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
            logger.warning("python-docx not installed, cannot extract DOCX text")
            return content
        except Exception as e:
            logger.error(f"Error extracting DOCX text: {e}")
            return content

    def _looks_like_base64(self, content: str) -> bool:
        """Check if content appears to be base64 encoded."""
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
        """Generate embeddings for fragments."""
        if not self._embedding_provider:
            return

        try:
            texts = [f.content for f in fragments]
            results = await self._embedding_provider.generate_embeddings_batch(texts)

            for fragment, result in zip(fragments, results):
                fragment.embedding = result.embedding

        except Exception as e:
            logger.error(f"Error generating embeddings: {e}")

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
            count: Maximum results to return.
            threshold: Minimum similarity threshold.

        Returns:
            List of search results.
        """
        if not self._embedding_provider:
            logger.warning("No embedding provider configured for search")
            return []

        try:
            # Generate query embedding
            result = await self._embedding_provider.generate_embedding(query)
            query_embedding = result.embedding

            # Search through fragments
            results: list[SearchResult] = []

            for fragment in self._fragments.values():
                if fragment.embedding is None:
                    continue

                similarity = self._cosine_similarity(
                    query_embedding,
                    fragment.embedding,
                )

                if similarity >= threshold:
                    # Get document info
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

            # Sort by similarity and limit
            results.sort(key=lambda x: x.similarity, reverse=True)
            return results[:count]

        except Exception as e:
            logger.error(f"Error searching knowledge: {e}")
            return []

    def _cosine_similarity(
        self,
        vec1: list[float],
        vec2: list[float],
    ) -> float:
        """Calculate cosine similarity between two vectors."""
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
        """
        Get knowledge items relevant to a query.

        Args:
            query: Query text.
            count: Maximum items to return.

        Returns:
            List of knowledge items.
        """
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
        """
        Delete a knowledge document and its fragments.

        Args:
            document_id: ID of the document to delete.

        Returns:
            True if deleted, False if not found.
        """
        if document_id not in self._documents:
            return False

        document = self._documents[document_id]

        # Delete fragments
        for fragment in document.fragments:
            self._fragments.pop(fragment.id, None)

        # Delete document
        del self._documents[document_id]

        logger.info(f"Deleted document {document_id}")
        return True

    def get_documents(self) -> list[KnowledgeDocument]:
        """Get all documents in the knowledge base."""
        return list(self._documents.values())

    def get_document(self, document_id: str) -> KnowledgeDocument | None:
        """Get a document by ID."""
        return self._documents.get(document_id)



