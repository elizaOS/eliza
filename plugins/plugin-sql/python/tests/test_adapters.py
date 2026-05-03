"""Tests for database adapters using real PostgreSQL via testcontainers."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

import pytest

from tests.conftest import as_uuid

if TYPE_CHECKING:
    from elizaos_plugin_sql.adapters.postgres import PostgresAdapter


class TestPostgresAdapter:
    @pytest.mark.asyncio
    async def test_initialization(self, postgres_adapter: PostgresAdapter) -> None:
        assert await postgres_adapter.is_ready()

    @pytest.mark.asyncio
    async def test_agent_crud(self, postgres_adapter: PostgresAdapter) -> None:
        agent_id = as_uuid(str(uuid.uuid4()))

        # Create
        created = await postgres_adapter.create_agent(
            {
                "id": agent_id,
                "name": "TestAgent",
                "bio": "A test agent",
            }
        )
        assert created is True

        # Read
        agent = await postgres_adapter.get_agent(agent_id)
        assert agent is not None
        assert agent["name"] == "TestAgent"

        # Update
        updated = await postgres_adapter.update_agent(agent_id, {"name": "UpdatedAgent"})
        assert updated is True

        agent = await postgres_adapter.get_agent(agent_id)
        assert agent["name"] == "UpdatedAgent"

        # Delete
        deleted = await postgres_adapter.delete_agent(agent_id)
        assert deleted is True

        agent = await postgres_adapter.get_agent(agent_id)
        assert agent is None

    @pytest.mark.asyncio
    async def test_entity_operations(self, postgres_adapter: PostgresAdapter) -> None:
        # First create an agent
        agent_id = as_uuid(str(uuid.uuid4()))
        await postgres_adapter.create_agent(
            {
                "id": agent_id,
                "name": "TestAgent",
                "bio": "A test agent",
            }
        )

        # Create entity
        entity_id = as_uuid(str(uuid.uuid4()))
        created = await postgres_adapter.create_entities(
            [
                {
                    "id": entity_id,
                    "agentId": agent_id,
                    "names": ["TestUser"],
                    "metadata": {"email": "test@example.com"},
                }
            ]
        )
        assert created is True

        # Read
        entities = await postgres_adapter.get_entities_by_ids([entity_id])
        assert entities is not None
        assert len(entities) == 1
        assert entities[0]["names"] == ["TestUser"]

    @pytest.mark.asyncio
    async def test_memory_operations(self, postgres_adapter: PostgresAdapter) -> None:
        # Create agent
        agent_id = as_uuid(str(uuid.uuid4()))
        await postgres_adapter.create_agent(
            {
                "id": agent_id,
                "name": "TestAgent",
                "bio": "A test agent",
            }
        )

        # Create room
        room_id = as_uuid(str(uuid.uuid4()))
        await postgres_adapter.create_rooms(
            [
                {
                    "id": room_id,
                    "source": "test",
                    "type": "DM",
                }
            ]
        )

        # Create entity
        entity_id = as_uuid(str(uuid.uuid4()))
        await postgres_adapter.create_entities(
            [
                {
                    "id": entity_id,
                    "agentId": agent_id,
                    "names": ["TestUser"],
                }
            ]
        )

        # Create memory
        memory_id = await postgres_adapter.create_memory(
            {
                "entityId": entity_id,
                "roomId": room_id,
                "content": {"text": "Hello, world!"},
            },
            table_name="memories",
        )
        assert memory_id is not None

        # Read
        memory = await postgres_adapter.get_memory_by_id(memory_id)
        assert memory is not None
        assert memory["content"]["text"] == "Hello, world!"

        # Count
        count = await postgres_adapter.count_memories(room_id)
        assert count == 1

        # Delete
        await postgres_adapter.delete_memory(memory_id)
        memory = await postgres_adapter.get_memory_by_id(memory_id)
        assert memory is None

    @pytest.mark.asyncio
    async def test_world_operations(self, postgres_adapter: PostgresAdapter) -> None:
        # Create agent
        agent_id = as_uuid(str(uuid.uuid4()))
        await postgres_adapter.create_agent(
            {
                "id": agent_id,
                "name": "TestAgent",
                "bio": "A test agent",
            }
        )

        # Create world
        world_id = await postgres_adapter.create_world(
            {
                "name": "TestWorld",
                "agentId": agent_id,
                "metadata": {"description": "A test world"},
            }
        )
        assert world_id is not None

        # Read
        world = await postgres_adapter.get_world(world_id)
        assert world is not None
        assert world["name"] == "TestWorld"

        # Update
        await postgres_adapter.update_world(
            {
                "id": world_id,
                "name": "UpdatedWorld",
            }
        )
        world = await postgres_adapter.get_world(world_id)
        assert world["name"] == "UpdatedWorld"

        # Get all
        all_worlds = await postgres_adapter.get_all_worlds()
        assert len(all_worlds) >= 1

        # Remove
        await postgres_adapter.remove_world(world_id)
        world = await postgres_adapter.get_world(world_id)
        assert world is None

    @pytest.mark.asyncio
    async def test_room_operations(self, postgres_adapter: PostgresAdapter) -> None:
        # Create room
        room_ids = await postgres_adapter.create_rooms(
            [
                {
                    "source": "test",
                    "type": "GROUP",
                    "name": "TestRoom",
                }
            ]
        )
        assert len(room_ids) == 1

        # Read
        rooms = await postgres_adapter.get_rooms_by_ids(room_ids)
        assert rooms is not None
        assert len(rooms) == 1
        assert rooms[0]["name"] == "TestRoom"

        # Update
        await postgres_adapter.update_room(
            {
                "id": room_ids[0],
                "name": "UpdatedRoom",
            }
        )
        rooms = await postgres_adapter.get_rooms_by_ids(room_ids)
        assert rooms[0]["name"] == "UpdatedRoom"

        # Delete
        await postgres_adapter.delete_room(room_ids[0])
        rooms = await postgres_adapter.get_rooms_by_ids(room_ids)
        assert rooms is None or len(rooms) == 0

    @pytest.mark.asyncio
    async def test_cache_operations(self, postgres_adapter: PostgresAdapter) -> None:
        # Set
        result = await postgres_adapter.set_cache("test_key", {"value": "test_value"})
        assert result is True

        # Get
        cached = await postgres_adapter.get_cache("test_key")
        assert cached is not None
        assert cached["value"] == "test_value"

        # Update
        await postgres_adapter.set_cache("test_key", {"value": "updated_value"})
        cached = await postgres_adapter.get_cache("test_key")
        assert cached["value"] == "updated_value"

        # Delete
        result = await postgres_adapter.delete_cache("test_key")
        assert result is True
        cached = await postgres_adapter.get_cache("test_key")
        assert cached is None

    @pytest.mark.asyncio
    async def test_task_operations(self, postgres_adapter: PostgresAdapter) -> None:
        # Create
        task_id = await postgres_adapter.create_task(
            {
                "name": "test-task",
                "description": "A test task",
                "status": "pending",
                "tags": ["test", "important"],
            }
        )
        assert task_id is not None

        # Read
        task = await postgres_adapter.get_task(task_id)
        assert task is not None
        assert task["name"] == "test-task"
        assert task["status"] == "pending"

        # Get by name
        tasks = await postgres_adapter.get_tasks_by_name("test-task")
        assert len(tasks) >= 1

        # Update
        await postgres_adapter.update_task(task_id, {"status": "completed"})
        task = await postgres_adapter.get_task(task_id)
        assert task["status"] == "completed"

        # Delete
        await postgres_adapter.delete_task(task_id)
        task = await postgres_adapter.get_task(task_id)
        assert task is None
