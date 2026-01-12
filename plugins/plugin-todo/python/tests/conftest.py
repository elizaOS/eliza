"""
Pytest configuration and fixtures.
"""

from uuid import uuid4

import pytest

# Skip all tests if elizaos is not installed
elizaos = pytest.importorskip("elizaos", reason="elizaos not installed")

from elizaos_plugin_todo import TodoClient, TodoConfig  # noqa: E402


@pytest.fixture
def config() -> TodoConfig:
    """Create a test configuration."""
    return TodoConfig(
        enable_reminders=False,  # Disable for faster tests
        cache_max_size=100,
    )


@pytest.fixture
async def client(config: TodoConfig) -> TodoClient:
    """Create and start a todo client."""
    client = TodoClient(config)
    await client.start()
    yield client
    await client.stop()


@pytest.fixture
def test_ids() -> dict[str, str]:
    """Generate test UUIDs."""
    return {
        "agent_id": uuid4(),
        "world_id": uuid4(),
        "room_id": uuid4(),
        "entity_id": uuid4(),
    }





