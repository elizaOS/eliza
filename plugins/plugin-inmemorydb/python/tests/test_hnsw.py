"""Tests for EphemeralHNSW."""

import pytest

from elizaos_plugin_inmemorydb.hnsw import EphemeralHNSW, cosine_distance


class TestCosineDistance:
    """Tests for cosine distance function."""

    def test_same_vectors(self) -> None:
        """Test distance between identical vectors."""
        vec = [1.0, 0.0, 0.0]
        dist = cosine_distance(vec, vec)
        assert dist < 0.001

    def test_orthogonal_vectors(self) -> None:
        """Test distance between orthogonal vectors."""
        vec1 = [1.0, 0.0, 0.0]
        vec2 = [0.0, 1.0, 0.0]
        dist = cosine_distance(vec1, vec2)
        assert abs(dist - 1.0) < 0.001

    def test_opposite_vectors(self) -> None:
        """Test distance between opposite vectors."""
        vec1 = [1.0, 0.0, 0.0]
        vec2 = [-1.0, 0.0, 0.0]
        dist = cosine_distance(vec1, vec2)
        assert abs(dist - 2.0) < 0.001

    def test_dimension_mismatch(self) -> None:
        """Test error on dimension mismatch."""
        vec1 = [1.0, 0.0]
        vec2 = [1.0, 0.0, 0.0]
        with pytest.raises(ValueError, match="dimension mismatch"):
            cosine_distance(vec1, vec2)

    def test_zero_vectors(self) -> None:
        """Test distance with zero vectors."""
        vec1 = [0.0, 0.0, 0.0]
        vec2 = [1.0, 0.0, 0.0]
        dist = cosine_distance(vec1, vec2)
        assert dist == 1.0


class TestEphemeralHNSW:
    """Tests for EphemeralHNSW class."""

    @pytest.fixture
    def hnsw(self) -> EphemeralHNSW:
        """Create a fresh HNSW instance."""
        return EphemeralHNSW()

    @pytest.mark.asyncio
    async def test_init(self, hnsw: EphemeralHNSW) -> None:
        """Test initialization."""
        await hnsw.init(3)
        assert hnsw._dimension == 3

    @pytest.mark.asyncio
    async def test_add_single(self, hnsw: EphemeralHNSW) -> None:
        """Test adding a single vector."""
        await hnsw.init(3)
        await hnsw.add("vec1", [1.0, 0.0, 0.0])
        assert hnsw.size() == 1

    @pytest.mark.asyncio
    async def test_add_multiple(self, hnsw: EphemeralHNSW) -> None:
        """Test adding multiple vectors."""
        await hnsw.init(3)
        await hnsw.add("vec1", [1.0, 0.0, 0.0])
        await hnsw.add("vec2", [0.0, 1.0, 0.0])
        await hnsw.add("vec3", [0.0, 0.0, 1.0])
        assert hnsw.size() == 3

    @pytest.mark.asyncio
    async def test_add_dimension_mismatch(self, hnsw: EphemeralHNSW) -> None:
        """Test error on dimension mismatch during add."""
        await hnsw.init(3)
        with pytest.raises(ValueError, match="dimension mismatch"):
            await hnsw.add("vec1", [1.0, 0.0])

    @pytest.mark.asyncio
    async def test_add_update_existing(self, hnsw: EphemeralHNSW) -> None:
        """Test updating an existing vector."""
        await hnsw.init(3)
        await hnsw.add("vec1", [1.0, 0.0, 0.0])
        await hnsw.add("vec1", [0.0, 1.0, 0.0])
        assert hnsw.size() == 1
        assert hnsw._nodes["vec1"].vector == [0.0, 1.0, 0.0]

    @pytest.mark.asyncio
    async def test_remove(self, hnsw: EphemeralHNSW) -> None:
        """Test removing a vector."""
        await hnsw.init(3)
        await hnsw.add("vec1", [1.0, 0.0, 0.0])
        await hnsw.add("vec2", [0.0, 1.0, 0.0])
        await hnsw.remove("vec1")
        assert hnsw.size() == 1

    @pytest.mark.asyncio
    async def test_remove_nonexistent(self, hnsw: EphemeralHNSW) -> None:
        """Test removing a non-existent vector."""
        await hnsw.init(3)
        await hnsw.remove("nonexistent")
        assert hnsw.size() == 0

    @pytest.mark.asyncio
    async def test_search_empty(self, hnsw: EphemeralHNSW) -> None:
        """Test search on empty index."""
        await hnsw.init(3)
        results = await hnsw.search([1.0, 0.0, 0.0], k=5)
        assert results == []

    @pytest.mark.asyncio
    async def test_search_basic(self, hnsw: EphemeralHNSW) -> None:
        """Test basic search."""
        await hnsw.init(3)
        await hnsw.add("vec1", [1.0, 0.0, 0.0])
        await hnsw.add("vec2", [0.9, 0.1, 0.0])
        await hnsw.add("vec3", [0.0, 1.0, 0.0])

        results = await hnsw.search([1.0, 0.0, 0.0], k=2, threshold=0.0)

        assert len(results) <= 2
        if results:
            # The closest should be vec1 or vec2
            assert results[0].id in ["vec1", "vec2"]

    @pytest.mark.asyncio
    async def test_search_with_threshold(self, hnsw: EphemeralHNSW) -> None:
        """Test search with similarity threshold."""
        await hnsw.init(3)
        await hnsw.add("vec1", [1.0, 0.0, 0.0])
        await hnsw.add("vec2", [0.0, 1.0, 0.0])  # Orthogonal, similarity = 0

        # Search with high threshold should only return similar vectors
        results = await hnsw.search([1.0, 0.0, 0.0], k=5, threshold=0.5)

        # Only vec1 should pass the threshold
        assert len(results) == 1
        assert results[0].id == "vec1"

    @pytest.mark.asyncio
    async def test_search_dimension_mismatch(self, hnsw: EphemeralHNSW) -> None:
        """Test error on dimension mismatch during search."""
        await hnsw.init(3)
        await hnsw.add("vec1", [1.0, 0.0, 0.0])

        with pytest.raises(ValueError, match="dimension mismatch"):
            await hnsw.search([1.0, 0.0], k=5)

    @pytest.mark.asyncio
    async def test_clear(self, hnsw: EphemeralHNSW) -> None:
        """Test clearing the index."""
        await hnsw.init(3)
        await hnsw.add("vec1", [1.0, 0.0, 0.0])
        await hnsw.add("vec2", [0.0, 1.0, 0.0])

        await hnsw.clear()

        assert hnsw.size() == 0
        assert hnsw._entry_point is None

    @pytest.mark.asyncio
    async def test_search_result_similarity(self, hnsw: EphemeralHNSW) -> None:
        """Test that search results include similarity scores."""
        await hnsw.init(3)
        await hnsw.add("vec1", [1.0, 0.0, 0.0])

        results = await hnsw.search([1.0, 0.0, 0.0], k=1, threshold=0.0)

        assert len(results) == 1
        assert results[0].similarity > 0.99  # Should be very close to 1
