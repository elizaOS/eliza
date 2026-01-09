"""
Pytest configuration and fixtures for elizaOS Bootstrap Plugin tests.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

import pytest
import pytest_asyncio

if TYPE_CHECKING:
    from elizaos.types import (
        Action,
        Character,
        Content,
        Entity,
        IAgentRuntime,
        Memory,
        Room,
        State,
        World,
    )


@dataclass
class MockCharacter:
    """Mock character for testing."""

    name: str = "TestAgent"
    bio: str = "A test agent for unit testing"
    adjectives: list[str] = field(default_factory=lambda: ["helpful", "friendly"])
    lore: str = "Created for testing purposes"
    topics: list[str] = field(default_factory=lambda: ["testing", "development"])
    style: MagicMock = field(default_factory=MagicMock)
    templates: dict[str, str] = field(default_factory=dict)


@dataclass
class MockContent:
    """Mock content for testing."""

    text: str = ""
    thought: str | None = None
    actions: list[str] = field(default_factory=list)
    providers: list[str] = field(default_factory=list)
    target: dict[str, str] | None = None
    options: list[dict[str, str]] | None = None


@dataclass
class MockMemory:
    """Mock memory for testing."""

    id: UUID = field(default_factory=uuid4)
    content: MockContent = field(default_factory=MockContent)
    room_id: UUID | None = None
    entity_id: UUID | None = None
    created_at: int = 0
    metadata: dict[str, str | int | float | bool | None] | None = None


@dataclass
class MockRoom:
    """Mock room for testing."""

    id: UUID = field(default_factory=uuid4)
    name: str = "Test Room"
    world_id: UUID | None = None
    metadata: dict[str, str | int | float | bool | None] | None = None


@dataclass
class MockWorld:
    """Mock world for testing."""

    id: UUID = field(default_factory=uuid4)
    name: str = "Test World"
    metadata: dict[str, list[str] | dict[str, str] | str | None] = field(
        default_factory=lambda: {"members": [], "roles": {}, "followedRooms": [], "mutedRooms": []}
    )


@dataclass
class MockEntity:
    """Mock entity for testing."""

    id: UUID = field(default_factory=uuid4)
    name: str = "Test User"
    entity_type: str = "user"
    metadata: dict[str, str | int | float | bool | None] | None = None


@dataclass
class MockState:
    """Mock state for testing."""

    values: dict[str, str | int | float | bool | list[str] | None] = field(default_factory=dict)


class MockLogger:
    """Mock logger for testing."""

    def info(self, data: dict[str, str], message: str) -> None:
        pass

    def debug(self, data: dict[str, str], message: str) -> None:
        pass

    def warning(self, data: dict[str, str], message: str) -> None:
        pass

    def error(self, data: dict[str, str], message: str) -> None:
        pass


@pytest.fixture
def mock_character() -> MockCharacter:
    """Provide a mock character."""
    return MockCharacter()


@pytest.fixture
def mock_room() -> MockRoom:
    """Provide a mock room."""
    return MockRoom()


@pytest.fixture
def mock_world() -> MockWorld:
    """Provide a mock world."""
    return MockWorld()


@pytest.fixture
def mock_entity() -> MockEntity:
    """Provide a mock entity."""
    return MockEntity()


@pytest.fixture
def mock_message(mock_room: MockRoom, mock_entity: MockEntity) -> MockMemory:
    """Provide a mock message."""
    return MockMemory(
        content=MockContent(text="Hello, how are you?"),
        room_id=mock_room.id,
        entity_id=mock_entity.id,
    )


@pytest.fixture
def mock_state() -> MockState:
    """Provide a mock state."""
    return MockState()


@pytest_asyncio.fixture
async def mock_runtime(
    mock_character: MockCharacter,
    mock_room: MockRoom,
    mock_world: MockWorld,
    mock_entity: MockEntity,
) -> AsyncGenerator[MagicMock, None]:
    """Provide a mock runtime."""
    runtime = MagicMock()
    runtime.agent_id = uuid4()
    runtime.character = mock_character
    runtime.logger = MockLogger()

    # Configure async methods
    runtime.get_room = AsyncMock(return_value=mock_room)
    runtime.get_world = AsyncMock(return_value=mock_world)
    runtime.get_entity = AsyncMock(return_value=mock_entity)
    runtime.update_world = AsyncMock()
    runtime.update_entity = AsyncMock()
    runtime.create_memory = AsyncMock()
    runtime.get_memories = AsyncMock(return_value=[])
    runtime.search_knowledge = AsyncMock(return_value=[])
    runtime.compose_state = AsyncMock(return_value=MockState())
    runtime.compose_prompt = MagicMock(return_value="Test prompt")
    runtime.use_model = AsyncMock(
        return_value="<response><thought>Test thought</thought><text>Test response</text></response>"
    )
    runtime.get_available_actions = MagicMock(return_value=[])
    runtime.get_all_settings = MagicMock(return_value={})
    runtime.set_setting = AsyncMock()
    runtime.get_setting = MagicMock(return_value=None)
    runtime.has_model = MagicMock(return_value=True)
    runtime.register_service = MagicMock()
    runtime.get_current_timestamp = MagicMock(return_value=1234567890)

    yield runtime

