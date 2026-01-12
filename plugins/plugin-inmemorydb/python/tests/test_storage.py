"""Tests for MemoryStorage."""

import pytest

from elizaos_plugin_inmemorydb.storage import MemoryStorage


class TestMemoryStorage:
    """Tests for MemoryStorage class."""

    @pytest.fixture
    def storage(self) -> MemoryStorage:
        """Create a fresh storage instance."""
        return MemoryStorage()

    @pytest.mark.asyncio
    async def test_init(self, storage: MemoryStorage) -> None:
        """Test initialization."""
        await storage.init()
        assert await storage.is_ready() is True

    @pytest.mark.asyncio
    async def test_close(self, storage: MemoryStorage) -> None:
        """Test closing storage."""
        await storage.init()
        await storage.close()
        assert await storage.is_ready() is False

    @pytest.mark.asyncio
    async def test_set_and_get(self, storage: MemoryStorage) -> None:
        """Test setting and getting items."""
        await storage.init()
        await storage.set("test", "item1", {"name": "Test Item"})

        result = await storage.get("test", "item1")

        assert result is not None
        assert result["name"] == "Test Item"

    @pytest.mark.asyncio
    async def test_get_nonexistent(self, storage: MemoryStorage) -> None:
        """Test getting a non-existent item."""
        await storage.init()

        result = await storage.get("test", "nonexistent")

        assert result is None

    @pytest.mark.asyncio
    async def test_get_all(self, storage: MemoryStorage) -> None:
        """Test getting all items in a collection."""
        await storage.init()
        await storage.set("test", "item1", {"name": "Item 1"})
        await storage.set("test", "item2", {"name": "Item 2"})
        await storage.set("test", "item3", {"name": "Item 3"})

        results = await storage.get_all("test")

        assert len(results) == 3

    @pytest.mark.asyncio
    async def test_get_where(self, storage: MemoryStorage) -> None:
        """Test getting items with a predicate."""
        await storage.init()
        await storage.set("test", "item1", {"name": "Alice", "age": 30})
        await storage.set("test", "item2", {"name": "Bob", "age": 25})
        await storage.set("test", "item3", {"name": "Charlie", "age": 35})

        results = await storage.get_where("test", lambda x: x["age"] > 28)

        assert len(results) == 2
        ages = [r["age"] for r in results]
        assert 25 not in ages

    @pytest.mark.asyncio
    async def test_delete(self, storage: MemoryStorage) -> None:
        """Test deleting an item."""
        await storage.init()
        await storage.set("test", "item1", {"name": "Test"})

        deleted = await storage.delete("test", "item1")

        assert deleted is True
        assert await storage.get("test", "item1") is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent(self, storage: MemoryStorage) -> None:
        """Test deleting a non-existent item."""
        await storage.init()

        deleted = await storage.delete("test", "nonexistent")

        assert deleted is False

    @pytest.mark.asyncio
    async def test_delete_many(self, storage: MemoryStorage) -> None:
        """Test deleting multiple items."""
        await storage.init()
        await storage.set("test", "item1", {"name": "Item 1"})
        await storage.set("test", "item2", {"name": "Item 2"})
        await storage.set("test", "item3", {"name": "Item 3"})

        await storage.delete_many("test", ["item1", "item2"])

        assert await storage.get("test", "item1") is None
        assert await storage.get("test", "item2") is None
        assert await storage.get("test", "item3") is not None

    @pytest.mark.asyncio
    async def test_delete_where(self, storage: MemoryStorage) -> None:
        """Test deleting items with a predicate."""
        await storage.init()
        await storage.set("test", "item1", {"name": "Alice", "active": True})
        await storage.set("test", "item2", {"name": "Bob", "active": False})
        await storage.set("test", "item3", {"name": "Charlie", "active": True})

        await storage.delete_where("test", lambda x: not x.get("active", False))

        results = await storage.get_all("test")
        assert len(results) == 2

    @pytest.mark.asyncio
    async def test_count(self, storage: MemoryStorage) -> None:
        """Test counting items."""
        await storage.init()
        await storage.set("test", "item1", {"name": "Item 1"})
        await storage.set("test", "item2", {"name": "Item 2"})
        await storage.set("test", "item3", {"name": "Item 3"})

        count = await storage.count("test")

        assert count == 3

    @pytest.mark.asyncio
    async def test_count_with_predicate(self, storage: MemoryStorage) -> None:
        """Test counting items with a predicate."""
        await storage.init()
        await storage.set("test", "item1", {"active": True})
        await storage.set("test", "item2", {"active": False})
        await storage.set("test", "item3", {"active": True})

        count = await storage.count("test", lambda x: x.get("active", False))

        assert count == 2

    @pytest.mark.asyncio
    async def test_clear(self, storage: MemoryStorage) -> None:
        """Test clearing all data."""
        await storage.init()
        await storage.set("test", "item1", {"name": "Item 1"})
        await storage.set("other", "item2", {"name": "Item 2"})

        await storage.clear()

        assert await storage.get_all("test") == []
        assert await storage.get_all("other") == []
