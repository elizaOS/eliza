"""Tests for KnowledgeService."""

import pytest

from elizaos_plugin_knowledge.types import (
    AddKnowledgeOptions,
    KnowledgeConfig,
)
from elizaos_plugin_knowledge.service import KnowledgeService


@pytest.fixture
def config() -> KnowledgeConfig:
    """Create a test configuration."""
    return KnowledgeConfig(
        embedding_provider="openai",
        embedding_model="text-embedding-3-small",
        chunk_size=100,
        chunk_overlap=20,
    )


@pytest.fixture
def service(config: KnowledgeConfig) -> KnowledgeService:
    """Create a test service."""
    return KnowledgeService(config=config)


class TestKnowledgeService:
    """Tests for KnowledgeService."""

    def test_init(self, service: KnowledgeService) -> None:
        """Test service initialization."""
        assert service.config is not None
        assert service.config.chunk_size == 100
        assert service.config.chunk_overlap == 20

    def test_generate_content_id_deterministic(self, service: KnowledgeService) -> None:
        """Test that content IDs are deterministic."""
        content = "This is test content for ID generation."
        agent_id = "agent-123"
        filename = "test.txt"

        id1 = service._generate_content_id(content, agent_id, filename)
        id2 = service._generate_content_id(content, agent_id, filename)

        assert id1 == id2

    def test_generate_content_id_different_content(self, service: KnowledgeService) -> None:
        """Test that different content produces different IDs."""
        agent_id = "agent-123"
        filename = "test.txt"

        id1 = service._generate_content_id("Content A", agent_id, filename)
        id2 = service._generate_content_id("Content B", agent_id, filename)

        assert id1 != id2

    def test_split_into_chunks_basic(self, service: KnowledgeService) -> None:
        """Test basic text chunking."""
        text = "This is a test sentence. " * 50

        result = service._split_into_chunks(text)

        assert len(result.chunks) > 0
        assert result.chunk_count == len(result.chunks)
        for chunk in result.chunks:
            assert len(chunk) > 0

    def test_split_into_chunks_preserves_content(self, service: KnowledgeService) -> None:
        """Test that chunking preserves all content (with overlap)."""
        text = "Word " * 100
        result = service._split_into_chunks(text)

        # Combined length of chunks should be >= original length
        total_content = "".join(result.chunks)
        assert len(total_content) >= len(text.strip())

    @pytest.mark.asyncio
    async def test_add_knowledge_text(self, service: KnowledgeService) -> None:
        """Test adding text knowledge."""
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
    async def test_add_knowledge_duplicate(self, service: KnowledgeService) -> None:
        """Test that duplicate content is handled."""
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
    async def test_delete_knowledge(self, service: KnowledgeService) -> None:
        """Test deleting knowledge."""
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

        # Try to delete again
        deleted_again = await service.delete_knowledge(result.document_id)
        assert not deleted_again

    @pytest.mark.asyncio
    async def test_get_documents(self, service: KnowledgeService) -> None:
        """Test getting all documents."""
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

    def test_cosine_similarity(self, service: KnowledgeService) -> None:
        """Test cosine similarity calculation."""
        vec1 = [1.0, 0.0, 0.0]
        vec2 = [1.0, 0.0, 0.0]
        vec3 = [0.0, 1.0, 0.0]

        # Same vectors should have similarity 1.0
        sim_same = service._cosine_similarity(vec1, vec2)
        assert abs(sim_same - 1.0) < 0.001

        # Orthogonal vectors should have similarity 0.0
        sim_ortho = service._cosine_similarity(vec1, vec3)
        assert abs(sim_ortho) < 0.001
