"""Test fixtures for elizaos-plugin-acp."""

from __future__ import annotations

from uuid import uuid4

import pytest


class MockContent:
    """Mock content for testing."""

    def __init__(self, text: str = "") -> None:
        self.text = text
        self.source = "test"


class MockMessage:
    """Mock message for testing."""

    def __init__(self, text: str = "", room_id=None, entity_id=None) -> None:
        self.id = uuid4()
        self.room_id = room_id or uuid4()
        self.entity_id = entity_id or uuid4()
        self.world_id = uuid4()
        self.content = MockContent(text)


class MockState:
    """Mock state for testing."""

    def __init__(self, data: dict | None = None) -> None:
        self.data = data or {}


class MockRuntime:
    """Mock runtime for testing."""

    def __init__(self) -> None:
        self.agent_id = uuid4()
        self.db = None
        self.cache_manager = MockCacheManager()

    async def compose_state(self, message, providers):
        """Mock compose_state."""
        return MockState()

    async def get_room(self, room_id):
        """Mock get_room."""

        class MockRoom:
            def __init__(self) -> None:
                self.world_id = uuid4()

        return MockRoom()


class MockCacheManager:
    """Mock cache manager for testing."""

    def __init__(self) -> None:
        self._cache: dict[str, object] = {}

    def get(self, key: str):
        """Get a value from cache."""
        return self._cache.get(key)

    def set(self, key: str, value: object) -> None:
        """Set a value in cache."""
        self._cache[key] = value

    def delete(self, key: str) -> None:
        """Delete a value from cache."""
        self._cache.pop(key, None)


@pytest.fixture
def mock_runtime() -> MockRuntime:
    """Create a mock runtime."""
    return MockRuntime()


@pytest.fixture
def mock_message() -> MockMessage:
    """Create a mock message."""
    return MockMessage(text="Buy 2 items")


@pytest.fixture
def mock_state() -> MockState:
    """Create a mock state."""
    return MockState()
