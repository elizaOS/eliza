"""
Integration tests for the Todo Plugin.
"""

from datetime import datetime, timedelta
from uuid import uuid4

import pytest

from elizaos_plugin_todo import (
    CacheManager,
    Priority,
    TaskType,
    TodoClient,
    TodoConfig,
    TodoDataService,
)
from elizaos_plugin_todo.data_service import create_todo_data_service
from elizaos_plugin_todo.types import CreateTodoParams, TodoFilters, UpdateTodoParams


class TestTodoDataService:
    """Tests for TodoDataService."""

    @pytest.fixture
    def data_service(self) -> TodoDataService:
        """Create a data service instance."""
        return create_todo_data_service()

    @pytest.fixture
    def test_params(self) -> dict:
        """Generate test parameters."""
        return {
            "agent_id": uuid4(),
            "world_id": uuid4(),
            "room_id": uuid4(),
            "entity_id": uuid4(),
        }

    @pytest.mark.asyncio
    async def test_create_and_get_todo(
        self, data_service: TodoDataService, test_params: dict
    ) -> None:
        """Test creating and retrieving a todo."""
        params = CreateTodoParams(
            name="Test Todo",
            description="A test todo item",
            type=TaskType.ONE_OFF,
            priority=Priority.HIGH,
            **test_params,
        )

        todo_id = await data_service.create_todo(params)
        assert todo_id is not None

        todo = await data_service.get_todo(todo_id)
        assert todo is not None
        assert todo.name == "Test Todo"
        assert todo.type == TaskType.ONE_OFF
        assert todo.priority == Priority.HIGH
        assert not todo.is_completed

    @pytest.mark.asyncio
    async def test_update_todo(self, data_service: TodoDataService, test_params: dict) -> None:
        """Test updating a todo."""
        params = CreateTodoParams(
            name="Original Name",
            type=TaskType.ONE_OFF,
            **test_params,
        )

        todo_id = await data_service.create_todo(params)

        updates = UpdateTodoParams(
            name="Updated Name",
            priority=Priority.CRITICAL,
        )
        result = await data_service.update_todo(todo_id, updates)
        assert result is True

        todo = await data_service.get_todo(todo_id)
        assert todo is not None
        assert todo.name == "Updated Name"
        assert todo.priority == Priority.CRITICAL

    @pytest.mark.asyncio
    async def test_complete_todo(self, data_service: TodoDataService, test_params: dict) -> None:
        """Test completing a todo."""
        params = CreateTodoParams(
            name="Complete Me",
            type=TaskType.ONE_OFF,
            **test_params,
        )

        todo_id = await data_service.create_todo(params)

        updates = UpdateTodoParams(
            is_completed=True,
            completed_at=datetime.utcnow(),
        )
        await data_service.update_todo(todo_id, updates)

        todo = await data_service.get_todo(todo_id)
        assert todo is not None
        assert todo.is_completed is True
        assert todo.completed_at is not None

    @pytest.mark.asyncio
    async def test_delete_todo(self, data_service: TodoDataService, test_params: dict) -> None:
        """Test deleting a todo."""
        params = CreateTodoParams(
            name="Delete Me",
            type=TaskType.ONE_OFF,
            **test_params,
        )

        todo_id = await data_service.create_todo(params)
        result = await data_service.delete_todo(todo_id)
        assert result is True

        todo = await data_service.get_todo(todo_id)
        assert todo is None

    @pytest.mark.asyncio
    async def test_get_todos_with_filters(
        self, data_service: TodoDataService, test_params: dict
    ) -> None:
        """Test filtering todos."""
        # Create multiple todos
        for i in range(3):
            params = CreateTodoParams(
                name=f"Todo {i}",
                type=TaskType.ONE_OFF if i < 2 else TaskType.DAILY,
                **test_params,
            )
            await data_service.create_todo(params)

        # Filter by type
        filters = TodoFilters(type=TaskType.ONE_OFF)
        todos = await data_service.get_todos(filters)
        assert len(todos) == 2

        filters = TodoFilters(type=TaskType.DAILY)
        todos = await data_service.get_todos(filters)
        assert len(todos) == 1

    @pytest.mark.asyncio
    async def test_get_overdue_todos(
        self, data_service: TodoDataService, test_params: dict
    ) -> None:
        """Test getting overdue todos."""
        # Create overdue todo
        params = CreateTodoParams(
            name="Overdue Task",
            type=TaskType.ONE_OFF,
            due_date=datetime.utcnow() - timedelta(days=1),
            **test_params,
        )
        await data_service.create_todo(params)

        # Create future todo
        params = CreateTodoParams(
            name="Future Task",
            type=TaskType.ONE_OFF,
            due_date=datetime.utcnow() + timedelta(days=1),
            **test_params,
        )
        await data_service.create_todo(params)

        overdue = await data_service.get_overdue_todos()
        assert len(overdue) == 1
        assert overdue[0].name == "Overdue Task"

    @pytest.mark.asyncio
    async def test_add_and_remove_tags(
        self, data_service: TodoDataService, test_params: dict
    ) -> None:
        """Test tag operations."""
        params = CreateTodoParams(
            name="Tagged Todo",
            type=TaskType.ONE_OFF,
            tags=["initial"],
            **test_params,
        )

        todo_id = await data_service.create_todo(params)

        # Add tags
        await data_service.add_tags(todo_id, ["new-tag", "another-tag"])
        todo = await data_service.get_todo(todo_id)
        assert todo is not None
        assert "new-tag" in todo.tags
        assert "another-tag" in todo.tags

        # Remove tags
        await data_service.remove_tags(todo_id, ["new-tag"])
        todo = await data_service.get_todo(todo_id)
        assert todo is not None
        assert "new-tag" not in todo.tags
        assert "another-tag" in todo.tags


class TestCacheManager:
    """Tests for CacheManager."""

    @pytest.fixture
    async def cache(self) -> CacheManager:
        """Create a cache manager instance."""
        cache = CacheManager(max_size=10, default_ttl_ms=60000)
        await cache.start()
        yield cache
        await cache.stop()

    @pytest.mark.asyncio
    async def test_set_and_get(self, cache: CacheManager) -> None:
        """Test basic set and get."""
        await cache.set("key1", "value1")
        value = await cache.get("key1")
        assert value == "value1"

    @pytest.mark.asyncio
    async def test_get_missing_key(self, cache: CacheManager) -> None:
        """Test getting a missing key."""
        value = await cache.get("nonexistent")
        assert value is None

    @pytest.mark.asyncio
    async def test_delete(self, cache: CacheManager) -> None:
        """Test deleting a key."""
        await cache.set("key1", "value1")
        result = await cache.delete("key1")
        assert result is True

        value = await cache.get("key1")
        assert value is None

    @pytest.mark.asyncio
    async def test_has(self, cache: CacheManager) -> None:
        """Test key existence check."""
        await cache.set("key1", "value1")
        assert await cache.has("key1") is True
        assert await cache.has("nonexistent") is False

    @pytest.mark.asyncio
    async def test_get_or_set(self, cache: CacheManager) -> None:
        """Test get_or_set functionality."""
        call_count = 0

        def fetcher() -> str:
            nonlocal call_count
            call_count += 1
            return "fetched_value"

        # First call should fetch
        value = await cache.get_or_set("key1", fetcher)
        assert value == "fetched_value"
        assert call_count == 1

        # Second call should use cache
        value = await cache.get_or_set("key1", fetcher)
        assert value == "fetched_value"
        assert call_count == 1  # Still 1

    @pytest.mark.asyncio
    async def test_stats(self, cache: CacheManager) -> None:
        """Test cache statistics."""
        await cache.set("key1", "value1")
        await cache.get("key1")  # Hit
        await cache.get("key2")  # Miss

        stats = cache.get_stats()
        assert stats.total_entries == 1
        assert stats.total_hits == 1
        assert stats.total_misses == 1


class TestTodoClient:
    """Tests for TodoClient."""

    @pytest.fixture
    def test_params(self) -> dict:
        """Generate test parameters."""
        return {
            "agent_id": uuid4(),
            "world_id": uuid4(),
            "room_id": uuid4(),
            "entity_id": uuid4(),
        }

    @pytest.mark.asyncio
    async def test_create_todo(self, test_params: dict) -> None:
        """Test creating a todo via client."""
        config = TodoConfig(enable_reminders=False)
        async with TodoClient(config) as client:
            todo = await client.create_todo(
                name="Client Test Todo",
                task_type=TaskType.ONE_OFF,
                priority=Priority.HIGH,
                **test_params,
            )

            assert todo.name == "Client Test Todo"
            assert todo.type == TaskType.ONE_OFF
            assert todo.priority == Priority.HIGH

    @pytest.mark.asyncio
    async def test_complete_and_uncomplete(self, test_params: dict) -> None:
        """Test completing and uncompleting a todo."""
        config = TodoConfig(enable_reminders=False)
        async with TodoClient(config) as client:
            todo = await client.create_todo(
                name="Complete Test",
                task_type=TaskType.ONE_OFF,
                **test_params,
            )

            # Complete
            completed = await client.complete_todo(todo.id)
            assert completed.is_completed is True

            # Uncomplete
            uncompleted = await client.uncomplete_todo(todo.id)
            assert uncompleted.is_completed is False

    @pytest.mark.asyncio
    async def test_get_todos_filtering(self, test_params: dict) -> None:
        """Test filtering todos via client."""
        config = TodoConfig(enable_reminders=False)
        async with TodoClient(config) as client:
            # Create multiple todos
            await client.create_todo(
                name="Task 1",
                task_type=TaskType.ONE_OFF,
                **test_params,
            )
            await client.create_todo(
                name="Task 2",
                task_type=TaskType.DAILY,
                **test_params,
            )

            # Get all
            all_todos = await client.get_todos(room_id=test_params["room_id"])
            assert len(all_todos) >= 2

            # Filter by type
            one_off = await client.get_todos(
                room_id=test_params["room_id"],
                task_type=TaskType.ONE_OFF,
            )
            assert len(one_off) >= 1
            assert all(t.type == TaskType.ONE_OFF for t in one_off)
