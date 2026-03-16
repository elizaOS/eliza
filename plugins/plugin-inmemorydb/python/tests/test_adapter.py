"""Tests for InMemoryDatabaseAdapter."""

import pytest
import pytest_asyncio

from elizaos_plugin_inmemorydb.adapter import InMemoryDatabaseAdapter
from elizaos_plugin_inmemorydb.storage import MemoryStorage


class TestInMemoryDatabaseAdapter:
    """Tests for InMemoryDatabaseAdapter class."""

    @pytest_asyncio.fixture
    async def adapter(self) -> InMemoryDatabaseAdapter:
        """Create a fresh adapter instance."""
        storage = MemoryStorage()
        adapter = InMemoryDatabaseAdapter(storage, "test-agent")
        await adapter.init()
        return adapter

    @pytest.mark.asyncio
    async def test_init(self, adapter: InMemoryDatabaseAdapter) -> None:
        """Test initialization."""
        assert await adapter.is_ready() is True

    @pytest.mark.asyncio
    async def test_close(self, adapter: InMemoryDatabaseAdapter) -> None:
        """Test closing the adapter."""
        await adapter.close()
        assert await adapter.is_ready() is False

    @pytest.mark.asyncio
    async def test_create_and_get_agent(self, adapter: InMemoryDatabaseAdapter) -> None:
        """Test creating and getting an agent."""
        agent = {"id": "agent-1", "name": "Test Agent"}
        success = await adapter.create_agent(agent)
        assert success is True

        result = await adapter.get_agent("agent-1")
        assert result is not None
        assert result["name"] == "Test Agent"

    @pytest.mark.asyncio
    async def test_update_agent(self, adapter: InMemoryDatabaseAdapter) -> None:
        """Test updating an agent."""
        await adapter.create_agent({"id": "agent-1", "name": "Original"})
        success = await adapter.update_agent("agent-1", {"name": "Updated"})
        assert success is True

        result = await adapter.get_agent("agent-1")
        assert result is not None
        assert result["name"] == "Updated"

    @pytest.mark.asyncio
    async def test_delete_agent(self, adapter: InMemoryDatabaseAdapter) -> None:
        """Test deleting an agent."""
        await adapter.create_agent({"id": "agent-1", "name": "Test"})
        success = await adapter.delete_agent("agent-1")
        assert success is True

        result = await adapter.get_agent("agent-1")
        assert result is None

    @pytest.mark.asyncio
    async def test_create_memory(self, adapter: InMemoryDatabaseAdapter) -> None:
        """Test creating a memory."""
        memory = {
            "content": {"text": "Test memory content"},
            "roomId": "room-1",
            "entityId": "entity-1",
        }
        memory_id = await adapter.create_memory(memory, "messages")
        assert memory_id is not None

        result = await adapter.get_memory_by_id(memory_id)
        assert result is not None
        assert result["content"]["text"] == "Test memory content"

    @pytest.mark.asyncio
    async def test_get_memories(self, adapter: InMemoryDatabaseAdapter) -> None:
        """Test getting memories."""
        await adapter.create_memory(
            {"content": {"text": "Memory 1"}, "roomId": "room-1"},
            "messages",
        )
        await adapter.create_memory(
            {"content": {"text": "Memory 2"}, "roomId": "room-1"},
            "messages",
        )
        await adapter.create_memory(
            {"content": {"text": "Memory 3"}, "roomId": "room-2"},
            "messages",
        )

        memories = await adapter.get_memories(room_id="room-1", table_name="messages")
        assert len(memories) == 2

    @pytest.mark.asyncio
    async def test_delete_memory(self, adapter: InMemoryDatabaseAdapter) -> None:
        """Test deleting a memory."""
        memory_id = await adapter.create_memory(
            {"content": {"text": "Test"}},
            "messages",
        )
        await adapter.delete_memory(memory_id)

        result = await adapter.get_memory_by_id(memory_id)
        assert result is None

    @pytest.mark.asyncio
    async def test_create_and_get_world(self, adapter: InMemoryDatabaseAdapter) -> None:
        """Test creating and getting a world."""
        world = {"name": "Test World", "settings": {}}
        world_id = await adapter.create_world(world)
        assert world_id is not None

        result = await adapter.get_world(world_id)
        assert result is not None
        assert result["name"] == "Test World"

    @pytest.mark.asyncio
    async def test_create_rooms(self, adapter: InMemoryDatabaseAdapter) -> None:
        """Test creating rooms."""
        rooms = [
            {"name": "Room 1"},
            {"name": "Room 2"},
        ]
        room_ids = await adapter.create_rooms(rooms)
        assert len(room_ids) == 2

        result = await adapter.get_rooms_by_ids(room_ids)
        assert result is not None
        assert len(result) == 2

    @pytest.mark.asyncio
    async def test_cache(self, adapter: InMemoryDatabaseAdapter) -> None:
        """Test cache operations."""
        await adapter.set_cache("key1", {"value": 42})

        result = await adapter.get_cache("key1")
        assert result is not None
        assert result["value"] == 42

        await adapter.delete_cache("key1")
        result = await adapter.get_cache("key1")
        assert result is None

    @pytest.mark.asyncio
    async def test_tasks(self, adapter: InMemoryDatabaseAdapter) -> None:
        """Test task operations."""
        task = {"name": "Test Task", "roomId": "room-1"}
        task_id = await adapter.create_task(task)
        assert task_id is not None

        result = await adapter.get_task(task_id)
        assert result is not None
        assert result["name"] == "Test Task"

        tasks = await adapter.get_tasks(room_id="room-1")
        assert len(tasks) == 1

        await adapter.delete_task(task_id)
        result = await adapter.get_task(task_id)
        assert result is None

    @pytest.mark.asyncio
    async def test_relationships(self, adapter: InMemoryDatabaseAdapter) -> None:
        """Test relationship operations."""
        success = await adapter.create_relationship(
            source_entity_id="entity-1",
            target_entity_id="entity-2",
            tags=["friend"],
        )
        assert success is True

        result = await adapter.get_relationship("entity-1", "entity-2")
        assert result is not None
        assert "friend" in result["tags"]

        relationships = await adapter.get_relationships("entity-1")
        assert len(relationships) == 1

    @pytest.mark.asyncio
    async def test_participants(self, adapter: InMemoryDatabaseAdapter) -> None:
        """Test participant operations."""
        await adapter.create_rooms([{"id": "room-1"}])
        await adapter.add_participants_room(["entity-1", "entity-2"], "room-1")

        is_participant = await adapter.is_room_participant("room-1", "entity-1")
        assert is_participant is True

        participants = await adapter.get_participants_for_room("room-1")
        assert len(participants) == 2

        await adapter.remove_participant("entity-1", "room-1")
        is_participant = await adapter.is_room_participant("room-1", "entity-1")
        assert is_participant is False

    @pytest.mark.asyncio
    async def test_vector_search(self, adapter: InMemoryDatabaseAdapter) -> None:
        """Test vector search with embeddings."""
        # Create memories with embeddings
        embedding1 = [1.0] * 384
        embedding2 = [0.0] * 384
        embedding2[0] = 1.0

        await adapter.create_memory(
            {
                "content": {"text": "Memory 1"},
                "embedding": embedding1,
                "roomId": "room-1",
            },
            "messages",
        )
        await adapter.create_memory(
            {
                "content": {"text": "Memory 2"},
                "embedding": embedding2,
                "roomId": "room-1",
            },
            "messages",
        )

        # Search with similar embedding
        query = [0.9] * 384
        results = await adapter.search_memories(
            table_name="messages",
            embedding=query,
            count=5,
            match_threshold=0.0,
        )

        # Should find at least one result
        assert len(results) >= 1
