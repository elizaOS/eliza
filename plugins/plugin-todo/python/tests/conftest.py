"""
Pytest configuration and fixtures.
"""

from uuid import uuid4

import pytest

# Check if elizaos is available
try:
    import elizaos  # noqa: F401

    HAS_ELIZAOS = True
except ImportError:
    HAS_ELIZAOS = False


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Skip all tests if elizaos is not installed."""
    if not HAS_ELIZAOS:
        skip_marker = pytest.mark.skip(reason="elizaos not installed")
        for item in items:
            item.add_marker(skip_marker)


# Only define fixtures if elizaos is available
if HAS_ELIZAOS:
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
        todo_client = TodoClient(config)
        await todo_client.start()
        yield todo_client
        await todo_client.stop()


@pytest.fixture
def test_ids() -> dict[str, str]:
    """Generate test UUIDs."""
    return {
        "agent_id": uuid4(),
        "world_id": uuid4(),
        "room_id": uuid4(),
        "entity_id": uuid4(),
    }
