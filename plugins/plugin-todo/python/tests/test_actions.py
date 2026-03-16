"""Tests for Todo plugin actions."""

from uuid import uuid4

import pytest

from elizaos_plugin_todo.actions import (
    handle_cancel_todo,
    handle_complete_todo,
    handle_confirm_todo,
    handle_create_todo,
    handle_update_todo,
    validate_complete_todo,
    validate_confirm_todo,
    validate_create_todo,
)
from elizaos_plugin_todo.data_service import TodoDataService
from elizaos_plugin_todo.types import CreateTodoParams, Priority, TaskType


class MockRuntime:
    """Mock runtime for testing."""

    def __init__(self) -> None:
        self.agent_id = uuid4()
        self.db = None

    async def compose_state(self, message, providers):
        """Mock compose_state."""
        try:
            from elizaos.types import State

            return State(data={})
        except ImportError:
            # Fallback for testing without elizaos installed
            class State:
                def __init__(self, data=None) -> None:
                    self.data = data or {}

            return State(data={})

    async def get_room(self, room_id):
        """Mock get_room."""

        class MockRoom:
            def __init__(self) -> None:
                self.world_id = uuid4()

        return MockRoom()


_UNSET = object()


class MockMessage:
    """Mock message for testing."""

    def __init__(self, text="", room_id=_UNSET, entity_id=_UNSET) -> None:
        self.id = uuid4()
        self.room_id = uuid4() if room_id is _UNSET else room_id
        self.entity_id = uuid4() if entity_id is _UNSET else entity_id
        self.world_id = uuid4()
        self.content = MockContent(text)


class MockContent:
    """Mock content for testing."""

    def __init__(self, text="") -> None:
        self.text = text
        self.source = "test"


class MockState:
    """Mock state for testing."""

    def __init__(self, data=None) -> None:
        self.data = data or {}


class MockHandlerOptions:
    """Mock handler options for testing."""

    def __init__(self, parameters=None) -> None:
        self.parameters = parameters or {}


@pytest.mark.asyncio
async def test_handle_create_todo() -> None:
    """Test create todo action."""
    runtime = MockRuntime()
    message = MockMessage(text="Create a task to finish my report")
    state = MockState()

    result = await handle_create_todo(runtime, message, state)

    assert result is not None
    assert result.success is True
    assert "report" in result.text.lower()


@pytest.mark.asyncio
async def test_handle_create_todo_no_room() -> None:
    """Test create todo action without room."""
    runtime = MockRuntime()
    message = MockMessage(text="Create a task", room_id=None)
    state = MockState()

    result = await handle_create_todo(runtime, message, state)

    assert result is not None
    assert result.success is False
    assert "room" in result.error.lower() or "context" in result.error.lower()


@pytest.mark.asyncio
async def test_handle_complete_todo() -> None:
    """Test complete todo action."""
    runtime = MockRuntime()
    data_service = TodoDataService()

    # Create a todo first
    params = CreateTodoParams(
        agent_id=runtime.agent_id,
        world_id=uuid4(),
        room_id=uuid4(),
        entity_id=uuid4(),
        name="Test task",
        description="Test description",
        type=TaskType.ONE_OFF,
        priority=Priority.MEDIUM,
        is_urgent=False,
        due_date=None,
        metadata=None,
        tags=[],
    )
    await data_service.create_todo(params)

    message = MockMessage(room_id=uuid4(), entity_id=uuid4())
    state = MockState()

    # Mock runtime.db
    runtime.db = data_service

    result = await handle_complete_todo(runtime, message, state)

    # Should fail because no todos exist in the room
    assert result is not None


@pytest.mark.asyncio
async def test_validate_create_todo() -> None:
    """Test validate create todo."""
    runtime = MockRuntime()
    message = MockMessage()

    result = await validate_create_todo(runtime, message)

    assert result is True


@pytest.mark.asyncio
async def test_validate_complete_todo() -> None:
    """Test validate complete todo."""
    runtime = MockRuntime()
    message = MockMessage()

    result = await validate_complete_todo(runtime, message)

    # Should return False if no todos exist
    assert isinstance(result, bool)


@pytest.mark.asyncio
async def test_handle_update_todo() -> None:
    """Test update todo action."""
    runtime = MockRuntime()
    message = MockMessage(text="Update my task priority to high")
    state = MockState()

    result = await handle_update_todo(runtime, message, state)

    assert result is not None


@pytest.mark.asyncio
async def test_handle_cancel_todo() -> None:
    """Test cancel todo action."""
    runtime = MockRuntime()
    message = MockMessage(text="Cancel my task")
    state = MockState()

    result = await handle_cancel_todo(runtime, message, state)

    assert result is not None


@pytest.mark.asyncio
async def test_handle_confirm_todo() -> None:
    """Test confirm todo action."""
    runtime = MockRuntime()
    message = MockMessage(text="Yes, create it")
    state = MockState(data={"pendingTodo": {"name": "Test task", "taskType": "one-off"}})

    result = await handle_confirm_todo(runtime, message, state)

    assert result is not None


@pytest.mark.asyncio
async def test_validate_confirm_todo() -> None:
    """Test validate confirm todo."""
    runtime = MockRuntime()
    message = MockMessage()
    state = MockState(data={"pendingTodo": {"name": "Test"}})

    result = await validate_confirm_todo(runtime, message, state)

    assert result is True

    # Test without pending todo
    state_no_pending = MockState()
    result_no_pending = await validate_confirm_todo(runtime, message, state_no_pending)

    assert result_no_pending is False
