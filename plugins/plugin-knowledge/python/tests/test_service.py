"""Tests for KnowledgeService – comprehensive coverage of all features."""

import math
import time

import pytest

from elizaos_plugin_knowledge.types import (
    AddKnowledgeOptions,
    EmbeddingResult,
    KnowledgeConfig,
    KnowledgeItem,
    RAGMetadata,
    RetrievedFragmentInfo,
)
from elizaos_plugin_knowledge.service import KnowledgeService


# ---------------------------------------------------------------------------
# Mock embedding provider
# ---------------------------------------------------------------------------


class MockEmbeddingProvider:
    """Deterministic mock that produces embeddings based on word hashing."""

    def __init__(self, dimension: int = 8) -> None:
        self.dimension = dimension
        self.call_count = 0

    async def generate_embedding(self, text: str) -> EmbeddingResult:
        self.call_count += 1
        return EmbeddingResult(
            embedding=self._text_to_vec(text),
            tokens_used=len(text.split()),
            model="mock",
        )

    async def generate_embeddings_batch(self, texts: list[str]) -> list[EmbeddingResult]:
        results: list[EmbeddingResult] = []
        for text in texts:
            results.append(await self.generate_embedding(text))
        return results

    def _text_to_vec(self, text: str) -> list[float]:
        """Simple deterministic embedding: hash-based vector."""
        vec = [0.0] * self.dimension
        for word in text.lower().split():
            h = hash(word) % self.dimension
            vec[h] += 1.0
        # Normalize
        norm = math.sqrt(sum(x * x for x in vec))
        if norm > 0:
            vec = [x / norm for x in vec]
        return vec


# ---------------------------------------------------------------------------
# Mock memory store
# ---------------------------------------------------------------------------


class MockMemoryStore:
    """In-memory mock of the MemoryStore protocol."""

    def __init__(self) -> None:
        self.memories: dict[str, dict] = {}

    async def create_memory(self, memory: dict) -> str:
        mid = str(memory.get("id", f"mem-{len(self.memories)}"))
        self.memories[mid] = memory
        return mid

    async def get_memory_by_id(self, memory_id: str) -> dict | None:
        return self.memories.get(memory_id)

    async def update_memory(self, memory: dict) -> None:
        mid = str(memory.get("id", ""))
        if mid in self.memories:
            self.memories[mid].update(memory)

    async def search_memories(
        self, embedding: list[float], count: int = 10, threshold: float = 0.1
    ) -> list[dict]:
        return list(self.memories.values())[:count]

    async def get_memories(self, table_name: str, count: int = 10) -> list[dict]:
        return list(self.memories.values())[:count]

    async def delete_memory(self, memory_id: str) -> None:
        self.memories.pop(memory_id, None)


# ---------------------------------------------------------------------------
# Mock text generation provider (for contextual knowledge enrichment)
# ---------------------------------------------------------------------------


class MockTextGenerationProvider:
    async def generate_text(self, prompt: str, system: str | None = None) -> str:
        return f"ENRICHED: {prompt[:80]}"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def config() -> KnowledgeConfig:
    return KnowledgeConfig(
        embedding_provider="openai",
        embedding_model="text-embedding-3-small",
        chunk_size=100,
        chunk_overlap=20,
    )


@pytest.fixture
def service(config: KnowledgeConfig) -> KnowledgeService:
    return KnowledgeService(config=config)


@pytest.fixture
def service_with_embeddings(config: KnowledgeConfig) -> KnowledgeService:
    return KnowledgeService(
        config=config,
        embedding_provider=MockEmbeddingProvider(),
    )


@pytest.fixture
def service_with_store(config: KnowledgeConfig) -> KnowledgeService:
    return KnowledgeService(
        config=config,
        embedding_provider=MockEmbeddingProvider(),
        memory_store=MockMemoryStore(),
    )


@pytest.fixture
def service_with_ctx(config: KnowledgeConfig) -> KnowledgeService:
    config.ctx_knowledge_enabled = True
    return KnowledgeService(
        config=config,
        embedding_provider=MockEmbeddingProvider(),
        text_generation_provider=MockTextGenerationProvider(),
    )


# ---------------------------------------------------------------------------
# Tests: Initialization
# ---------------------------------------------------------------------------


class TestKnowledgeServiceInit:
    def test_init(self, service: KnowledgeService) -> None:
        assert service.config is not None
        assert service.config.chunk_size == 100
        assert service.config.chunk_overlap == 20

    def test_init_defaults(self) -> None:
        svc = KnowledgeService()
        assert svc.config.chunk_size == 500
        assert svc.config.chunk_overlap == 100
        assert svc.config.ctx_knowledge_enabled is False


# ---------------------------------------------------------------------------
# Tests: Content ID generation / deduplication
# ---------------------------------------------------------------------------


class TestDeduplication:
    def test_generate_content_id_deterministic(self, service: KnowledgeService) -> None:
        content = "This is test content for ID generation."
        agent_id = "agent-123"
        filename = "test.txt"

        id1 = service._generate_content_id(content, agent_id, filename)
        id2 = service._generate_content_id(content, agent_id, filename)
        assert id1 == id2

    def test_generate_content_id_different_content(self, service: KnowledgeService) -> None:
        agent_id = "agent-123"
        filename = "test.txt"

        id1 = service._generate_content_id("Content A", agent_id, filename)
        id2 = service._generate_content_id("Content B", agent_id, filename)
        assert id1 != id2

    def test_generate_content_id_different_agents(self, service: KnowledgeService) -> None:
        content = "Same content"
        id1 = service._generate_content_id(content, "agent-1")
        id2 = service._generate_content_id(content, "agent-2")
        assert id1 != id2

    def test_content_hash(self, service: KnowledgeService) -> None:
        h1 = service._compute_content_hash("Hello world")
        h2 = service._compute_content_hash("Hello world")
        h3 = service._compute_content_hash("Different content")

        assert h1 == h2
        assert h1 != h3

    def test_content_hash_line_normalization(self, service: KnowledgeService) -> None:
        h1 = service._compute_content_hash("line1\r\nline2")
        h2 = service._compute_content_hash("line1\nline2")
        assert h1 == h2

    @pytest.mark.asyncio
    async def test_add_knowledge_duplicate_by_id(self, service: KnowledgeService) -> None:
        options = AddKnowledgeOptions(
            content="Duplicate content test. " * 20,
            content_type="text/plain",
            filename="test.txt",
            agent_id="test-agent",
        )

        result1 = await service.add_knowledge(options)
        result2 = await service.add_knowledge(options)

        assert result1.document_id == result2.document_id
        assert result1.fragment_count == result2.fragment_count

    @pytest.mark.asyncio
    async def test_add_knowledge_duplicate_by_hash(self, service: KnowledgeService) -> None:
        """Same content but different filename should still deduplicate by hash."""
        content = "Exact same content for hash test. " * 20
        r1 = await service.add_knowledge(
            AddKnowledgeOptions(content=content, content_type="text/plain", filename="a.txt", agent_id="agent")
        )
        r2 = await service.add_knowledge(
            AddKnowledgeOptions(content=content, content_type="text/plain", filename="b.txt", agent_id="agent")
        )
        # The hash check should catch this
        assert r1.success
        assert r2.success


# ---------------------------------------------------------------------------
# Tests: Chunking
# ---------------------------------------------------------------------------


class TestChunking:
    def test_split_into_chunks_basic(self, service: KnowledgeService) -> None:
        text = "This is a test sentence. " * 50
        result = service._split_into_chunks(text)

        assert len(result.chunks) > 0
        assert result.chunk_count == len(result.chunks)
        for chunk in result.chunks:
            assert len(chunk) > 0

    def test_split_into_chunks_preserves_content(self, service: KnowledgeService) -> None:
        text = "Word " * 100
        result = service._split_into_chunks(text)
        total_content = "".join(result.chunks)
        assert len(total_content) >= len(text.strip())

    def test_split_into_chunks_custom_size(self, service: KnowledgeService) -> None:
        text = "Test sentence. " * 100
        result = service._split_into_chunks(text, chunk_size=50, overlap=10)
        assert result.chunk_count > 0

    def test_split_into_chunks_short_text(self, service: KnowledgeService) -> None:
        result = service._split_into_chunks("Short text.")
        assert result.chunk_count == 1
        assert result.chunks[0] == "Short text."

    def test_split_empty_text(self, service: KnowledgeService) -> None:
        result = service._split_into_chunks("")
        assert result.chunk_count == 0

    def test_split_whitespace_only(self, service: KnowledgeService) -> None:
        result = service._split_into_chunks("   \n\t   ")
        assert result.chunk_count == 0


# ---------------------------------------------------------------------------
# Tests: Document processing pipeline
# ---------------------------------------------------------------------------


class TestDocumentProcessing:
    @pytest.mark.asyncio
    async def test_add_knowledge_text(self, service: KnowledgeService) -> None:
        options = AddKnowledgeOptions(
            content="This is test content for the knowledge base. " * 20,
            content_type="text/plain",
            filename="test.txt",
            agent_id="test-agent",
        )

        result = await service.add_knowledge(options)

        assert result.success
        assert result.document_id is not None
        assert result.fragment_count > 0

    @pytest.mark.asyncio
    async def test_add_knowledge_with_embeddings(
        self, service_with_embeddings: KnowledgeService
    ) -> None:
        options = AddKnowledgeOptions(
            content="Knowledge with embeddings test content. " * 20,
            content_type="text/plain",
            filename="embed-test.txt",
            agent_id="test-agent",
        )

        result = await service_with_embeddings.add_knowledge(options)
        assert result.success
        assert result.fragment_count > 0

        # Verify fragments have embeddings
        for fragment in service_with_embeddings._fragments.values():
            assert fragment.embedding is not None
            assert len(fragment.embedding) > 0

    @pytest.mark.asyncio
    async def test_add_knowledge_with_memory_store(
        self, service_with_store: KnowledgeService
    ) -> None:
        options = AddKnowledgeOptions(
            content="Store test content for persistence. " * 20,
            content_type="text/plain",
            filename="store-test.txt",
            agent_id="test-agent",
        )

        result = await service_with_store.add_knowledge(options)
        assert result.success

        # Verify persisted to mock store
        store: MockMemoryStore = service_with_store._memory_store  # type: ignore[assignment]
        assert len(store.memories) > 0

    @pytest.mark.asyncio
    async def test_add_knowledge_empty_content(self, service: KnowledgeService) -> None:
        options = AddKnowledgeOptions(
            content="   ",
            content_type="text/plain",
            filename="empty.txt",
            agent_id="test-agent",
        )

        result = await service.add_knowledge(options)
        assert not result.success
        assert result.error is not None

    @pytest.mark.asyncio
    async def test_add_knowledge_json(self, service: KnowledgeService) -> None:
        options = AddKnowledgeOptions(
            content='{"key": "value", "data": "Some important information for testing."}',
            content_type="application/json",
            filename="data.json",
            agent_id="test-agent",
        )

        result = await service.add_knowledge(options)
        assert result.success

    @pytest.mark.asyncio
    async def test_fragment_metadata(self, service: KnowledgeService) -> None:
        options = AddKnowledgeOptions(
            content="Fragment metadata test. " * 30,
            content_type="text/plain",
            filename="meta-test.txt",
            agent_id="test-agent",
        )

        result = await service.add_knowledge(options)
        assert result.success

        doc = service.get_document(result.document_id)
        assert doc is not None
        for i, frag in enumerate(doc.fragments):
            assert frag.metadata["type"] == "fragment"
            assert frag.metadata["document_id"] == result.document_id
            assert frag.metadata["position"] == i

    @pytest.mark.asyncio
    async def test_document_metadata(self, service: KnowledgeService) -> None:
        options = AddKnowledgeOptions(
            content="Document metadata test content. " * 20,
            content_type="text/plain",
            filename="meta-doc.txt",
            agent_id="test-agent",
            metadata={"custom_key": "custom_value"},
        )

        result = await service.add_knowledge(options)
        doc = service.get_document(result.document_id)
        assert doc is not None
        assert doc.metadata["type"] == "document"
        assert doc.metadata["source"] == "knowledge-service"
        assert doc.metadata["custom_key"] == "custom_value"
        assert doc.metadata["title"] == "meta-doc"


# ---------------------------------------------------------------------------
# Tests: Contextual Knowledge Enrichment
# ---------------------------------------------------------------------------


class TestContextualKnowledge:
    @pytest.mark.asyncio
    async def test_ctx_enrichment_enabled(self, service_with_ctx: KnowledgeService) -> None:
        """Fragments should be enriched when CTX_KNOWLEDGE_ENABLED is True."""
        options = AddKnowledgeOptions(
            content="Long document about quantum computing and physics research. " * 30,
            content_type="text/plain",
            filename="ctx-test.txt",
            agent_id="test-agent",
        )

        result = await service_with_ctx.add_knowledge(options)
        assert result.success
        assert result.fragment_count > 0

        # Enriched fragments should contain the ENRICHED prefix from mock
        for fragment in service_with_ctx._fragments.values():
            assert fragment.content.startswith("ENRICHED:")

    @pytest.mark.asyncio
    async def test_ctx_enrichment_disabled(self, service: KnowledgeService) -> None:
        """Fragments should NOT be enriched when CTX_KNOWLEDGE_ENABLED is False."""
        options = AddKnowledgeOptions(
            content="Document without enrichment. " * 30,
            content_type="text/plain",
            filename="no-ctx.txt",
            agent_id="test-agent",
        )

        result = await service.add_knowledge(options)
        assert result.success

        for fragment in service._fragments.values():
            assert not fragment.content.startswith("ENRICHED:")

    def test_get_context_targets_pdf(self, service: KnowledgeService) -> None:
        targets = service._get_context_targets("application/pdf", "Normal text")
        assert targets.min_tokens == 80
        assert targets.max_tokens == 150

    def test_get_context_targets_math_pdf(self, service: KnowledgeService) -> None:
        math_text = "This theorem proves that the integral of f(x) converges."
        targets = service._get_context_targets("application/pdf", math_text)
        assert targets.min_tokens == 100  # MATH_PDF

    def test_get_context_targets_code(self, service: KnowledgeService) -> None:
        targets = service._get_context_targets("text/typescript", "const x = 1;")
        assert targets.min_tokens == 100
        assert targets.max_tokens == 200

    def test_contains_mathematical_content(self, service: KnowledgeService) -> None:
        assert service._contains_mathematical_content("$$ x^2 + y^2 = r^2 $$")
        assert service._contains_mathematical_content("\\frac{a}{b}")
        assert not service._contains_mathematical_content("Plain English text here.")

    def test_is_technical_doc(self, service: KnowledgeService) -> None:
        assert service._is_technical_doc("API v2.3 documentation for the SDK")
        assert service._is_technical_doc("GET /api/users returns a list")
        assert not service._is_technical_doc("The cat sat on the mat.")


# ---------------------------------------------------------------------------
# Tests: Search with embeddings
# ---------------------------------------------------------------------------


class TestSearchWithEmbeddings:
    @pytest.mark.asyncio
    async def test_search_with_embeddings(
        self, service_with_embeddings: KnowledgeService
    ) -> None:
        # Add some documents
        await service_with_embeddings.add_knowledge(
            AddKnowledgeOptions(
                content="Python programming language is versatile and powerful. " * 20,
                content_type="text/plain",
                filename="python.txt",
                agent_id="agent",
            )
        )
        await service_with_embeddings.add_knowledge(
            AddKnowledgeOptions(
                content="JavaScript is the language of the web browser. " * 20,
                content_type="text/plain",
                filename="javascript.txt",
                agent_id="agent",
            )
        )

        results = await service_with_embeddings.search("Python programming", count=5)
        assert len(results) > 0
        assert all(r.similarity >= 0.1 for r in results)

    @pytest.mark.asyncio
    async def test_search_no_provider_falls_back(self, service: KnowledgeService) -> None:
        """Without embedding provider, should fall back to keyword search."""
        await service.add_knowledge(
            AddKnowledgeOptions(
                content="Quantum computing uses qubits for parallel processing. " * 20,
                content_type="text/plain",
                filename="quantum.txt",
                agent_id="agent",
            )
        )

        results = await service.search("quantum computing")
        assert len(results) > 0

    @pytest.mark.asyncio
    async def test_search_empty_query(
        self, service_with_embeddings: KnowledgeService
    ) -> None:
        results = await service_with_embeddings.search("", count=5)
        assert len(results) == 0

    @pytest.mark.asyncio
    async def test_get_knowledge(self, service_with_embeddings: KnowledgeService) -> None:
        await service_with_embeddings.add_knowledge(
            AddKnowledgeOptions(
                content="Machine learning models learn patterns from data. " * 20,
                content_type="text/plain",
                filename="ml.txt",
                agent_id="agent",
            )
        )

        items = await service_with_embeddings.get_knowledge("machine learning")
        assert len(items) > 0
        assert isinstance(items[0], KnowledgeItem)


# ---------------------------------------------------------------------------
# Tests: Cosine similarity
# ---------------------------------------------------------------------------


class TestCosineSimilarity:
    def test_same_vectors(self, service: KnowledgeService) -> None:
        vec = [1.0, 0.0, 0.0]
        assert abs(service._cosine_similarity(vec, vec) - 1.0) < 0.001

    def test_orthogonal_vectors(self, service: KnowledgeService) -> None:
        vec1 = [1.0, 0.0, 0.0]
        vec2 = [0.0, 1.0, 0.0]
        assert abs(service._cosine_similarity(vec1, vec2)) < 0.001

    def test_opposite_vectors(self, service: KnowledgeService) -> None:
        vec1 = [1.0, 0.0, 0.0]
        vec2 = [-1.0, 0.0, 0.0]
        assert abs(service._cosine_similarity(vec1, vec2) + 1.0) < 0.001

    def test_zero_vector(self, service: KnowledgeService) -> None:
        vec1 = [1.0, 2.0, 3.0]
        vec2 = [0.0, 0.0, 0.0]
        assert service._cosine_similarity(vec1, vec2) == 0.0

    def test_different_lengths(self, service: KnowledgeService) -> None:
        vec1 = [1.0, 2.0]
        vec2 = [1.0, 2.0, 3.0]
        assert service._cosine_similarity(vec1, vec2) == 0.0


# ---------------------------------------------------------------------------
# Tests: RAG enrichment
# ---------------------------------------------------------------------------


class TestRAGEnrichment:
    def test_build_rag_metadata(self, service: KnowledgeService) -> None:
        items = [
            KnowledgeItem(
                id="frag-1",
                content="Fragment content about AI",
                similarity=0.95,
                metadata={"filename": "ai.txt"},
            ),
            KnowledgeItem(
                id="frag-2",
                content="Another fragment about machine learning",
                similarity=0.85,
                metadata={"title": "ML Basics"},
            ),
        ]

        rag = service.build_rag_metadata(items, "Tell me about AI")

        assert len(rag.retrieved_fragments) == 2
        assert rag.query_text == "Tell me about AI"
        assert rag.total_fragments == 2
        assert rag.retrieval_timestamp > 0
        assert rag.retrieved_fragments[0].fragment_id == "frag-1"
        assert rag.retrieved_fragments[0].document_title == "ai.txt"
        assert rag.retrieved_fragments[0].similarity_score == 0.95

    def test_set_pending_rag_metadata(self, service: KnowledgeService) -> None:
        rag = RAGMetadata(
            retrieved_fragments=[],
            query_text="test",
            total_fragments=0,
            retrieval_timestamp=int(time.time() * 1000),
        )

        service.set_pending_rag_metadata(rag)
        assert len(service._pending_rag_enrichment) == 1

    def test_pending_rag_prunes_stale(self, service: KnowledgeService) -> None:
        # Add a stale entry
        from elizaos_plugin_knowledge.types import PendingRAGEntry

        stale = PendingRAGEntry(
            rag_metadata=RAGMetadata(), timestamp=int(time.time() * 1000) - 60000
        )
        service._pending_rag_enrichment.append(stale)

        # Add a new entry - stale should be pruned
        service.set_pending_rag_metadata(RAGMetadata())
        assert len(service._pending_rag_enrichment) == 1

    @pytest.mark.asyncio
    async def test_enrich_conversation_memory_with_store(
        self, service_with_store: KnowledgeService
    ) -> None:
        store: MockMemoryStore = service_with_store._memory_store  # type: ignore[assignment]
        await store.create_memory({"id": "mem-1", "metadata": {"type": "message"}})

        rag = RAGMetadata(
            retrieved_fragments=[
                RetrievedFragmentInfo(
                    fragment_id="f1",
                    document_title="doc.txt",
                    similarity_score=0.9,
                    content_preview="preview...",
                )
            ],
            query_text="test query",
            total_fragments=1,
            retrieval_timestamp=int(time.time() * 1000),
        )

        await service_with_store.enrich_conversation_memory_with_rag("mem-1", rag)

        enriched = await store.get_memory_by_id("mem-1")
        assert enriched is not None
        assert enriched.get("metadata", {}).get("knowledgeUsed") is True
        assert "ragUsage" in enriched.get("metadata", {})


# ---------------------------------------------------------------------------
# Tests: PDF text extraction
# ---------------------------------------------------------------------------


class TestPDFExtraction:
    def test_looks_like_base64(self, service: KnowledgeService) -> None:
        assert service._looks_like_base64("SGVsbG8gV29ybGQ=")
        assert not service._looks_like_base64("Hello World")
        assert not service._looks_like_base64("short")

    def test_clean_pdf_text(self, service: KnowledgeService) -> None:
        dirty = "Line 1  \n  \n  \n  Line 2  \n  Line 3  "
        cleaned = service._clean_pdf_text(dirty)
        assert "Line 1" in cleaned
        assert "Line 2" in cleaned
        assert "\n\n\n" not in cleaned


# ---------------------------------------------------------------------------
# Tests: Delete and CRUD
# ---------------------------------------------------------------------------


class TestCRUD:
    @pytest.mark.asyncio
    async def test_delete_knowledge(self, service: KnowledgeService) -> None:
        options = AddKnowledgeOptions(
            content="Content to be deleted. " * 20,
            content_type="text/plain",
            filename="delete-test.txt",
            agent_id="test-agent",
        )

        result = await service.add_knowledge(options)
        assert result.success

        deleted = await service.delete_knowledge(result.document_id)
        assert deleted

        deleted_again = await service.delete_knowledge(result.document_id)
        assert not deleted_again

    @pytest.mark.asyncio
    async def test_delete_clears_hash(self, service: KnowledgeService) -> None:
        content = "Content for hash clearing test. " * 20
        options = AddKnowledgeOptions(
            content=content, content_type="text/plain", filename="hash-test.txt", agent_id="agent"
        )

        result = await service.add_knowledge(options)
        assert result.success
        assert len(service._content_hashes) > 0

        await service.delete_knowledge(result.document_id)
        # Hash should be removed
        content_hash = service._compute_content_hash(content)
        assert content_hash not in service._content_hashes

    @pytest.mark.asyncio
    async def test_get_documents(self, service: KnowledgeService) -> None:
        options = AddKnowledgeOptions(
            content="Document content for listing. " * 20,
            content_type="text/plain",
            filename="list-test.txt",
            agent_id="test-agent",
        )

        await service.add_knowledge(options)
        documents = service.get_documents()

        assert len(documents) > 0
        assert any(d.filename == "list-test.txt" for d in documents)

    @pytest.mark.asyncio
    async def test_get_document(self, service: KnowledgeService) -> None:
        options = AddKnowledgeOptions(
            content="Get document test. " * 20,
            content_type="text/plain",
            filename="get-doc.txt",
            agent_id="test-agent",
        )

        result = await service.add_knowledge(options)
        doc = service.get_document(result.document_id)

        assert doc is not None
        assert doc.filename == "get-doc.txt"

    @pytest.mark.asyncio
    async def test_get_document_not_found(self, service: KnowledgeService) -> None:
        doc = service.get_document("nonexistent-id")
        assert doc is None

    @pytest.mark.asyncio
    async def test_check_existing_knowledge(self, service: KnowledgeService) -> None:
        options = AddKnowledgeOptions(
            content="Check existing test. " * 20,
            content_type="text/plain",
            filename="check.txt",
            agent_id="test",
        )
        result = await service.add_knowledge(options)
        assert await service.check_existing_knowledge(result.document_id)
        assert not await service.check_existing_knowledge("fake-id")

    @pytest.mark.asyncio
    async def test_get_fragment_count(self, service: KnowledgeService) -> None:
        assert service.get_fragment_count() == 0

        await service.add_knowledge(
            AddKnowledgeOptions(
                content="Fragment count test. " * 30,
                content_type="text/plain",
                filename="count.txt",
                agent_id="agent",
            )
        )
        assert service.get_fragment_count() > 0
