"""Tests for Todo plugin providers."""

from datetime import datetime, timedelta
from uuid import uuid4

import pytest

from elizaos_plugin_todo.data_service import TodoDataService
from elizaos_plugin_todo.providers import get_todos
from elizaos_plugin_todo.types import CreateTodoParams, Priority, TaskType


class MockRuntime:
    """Mock runtime for testing."""

    def __init__(self) -> None:
        self.agent_id = uuid4()
        self.db = None

    async def get_room(self, room_id):
        """Mock get_room."""

        class MockRoom:
            def __init__(self) -> None:
                self.world_id = uuid4()

        return MockRoom()


_UNSET = object()


class MockMessage:
    """Mock message for testing."""

    def __init__(self, room_id=_UNSET, entity_id=_UNSET) -> None:
        self.id = uuid4()
        self.room_id = uuid4() if room_id is _UNSET else room_id
        self.entity_id = uuid4() if entity_id is _UNSET else entity_id
        self.world_id = uuid4()


@pytest.mark.asyncio
async def test_get_todos() -> None:
    """Test get todos provider."""
    runtime = MockRuntime()
    message = MockMessage()

    result = await get_todos(runtime, message)

    assert result is not None
    assert hasattr(result, "text")
    assert hasattr(result, "data")
    assert hasattr(result, "values")


@pytest.mark.asyncio
async def test_get_todos_with_data() -> None:
    """Test get todos provider with actual data."""
    runtime = MockRuntime()
    data_service = TodoDataService()
    runtime.db = data_service

    entity_id = uuid4()
    room_id = uuid4()
    world_id = uuid4()

    # Create some test todos
    params1 = CreateTodoParams(
        agent_id=runtime.agent_id,
        world_id=world_id,
        room_id=room_id,
        entity_id=entity_id,
        name="Daily exercise",
        description="Do 50 pushups",
        type=TaskType.DAILY,
        priority=None,
        is_urgent=False,
        due_date=None,
        metadata=None,
        tags=["daily"],
    )
    await data_service.create_todo(params1)

    params2 = CreateTodoParams(
        agent_id=runtime.agent_id,
        world_id=world_id,
        room_id=room_id,
        entity_id=entity_id,
        name="Finish report",
        description="Complete the quarterly report",
        type=TaskType.ONE_OFF,
        priority=Priority.HIGH,
        is_urgent=True,
        due_date=datetime.utcnow() + timedelta(days=1),
        metadata=None,
        tags=["one-off"],
    )
    await data_service.create_todo(params2)

    message = MockMessage(room_id=room_id, entity_id=entity_id)

    result = await get_todos(runtime, message)

    assert result is not None
    assert result.text is not None
    assert "Daily exercise" in result.text or "Finish report" in result.text
    assert result.data is not None
    assert "dailyTodos" in result.data or "oneOffTodos" in result.data


@pytest.mark.asyncio
async def test_get_todos_no_room() -> None:
    """Test get todos provider without room."""
    runtime = MockRuntime()
    message = MockMessage(room_id=None)

    result = await get_todos(runtime, message)

    assert result is not None
    assert (
        "No room context" in result.text
        or result.text == "Sorry, there was an error retrieving your tasks."
    )


@pytest.mark.asyncio
async def test_get_todos_empty() -> None:
    """Test get todos provider with no todos."""
    runtime = MockRuntime()
    data_service = TodoDataService()
    runtime.db = data_service

    message = MockMessage()

    result = await get_todos(runtime, message)

    assert result is not None
    assert result.text is not None
    # Should contain sections for different todo types
    assert "Daily Todos" in result.text or "One-off Todos" in result.text
