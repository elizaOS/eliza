"""
Pytest configuration and fixtures.
"""

import pytest
import asyncio
from uuid import uuid4

from elizaos_plugin_todo import TodoClient, TodoConfig


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


