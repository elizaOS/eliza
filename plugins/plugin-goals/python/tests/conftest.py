"""Pytest configuration for elizaos_plugin_goals tests.

Note: The pyproject.toml configures pytest to disable the anchorpy plugin
which requires pytest_xprocess. Simply run: pytest
"""

import pytest


@pytest.fixture
def sample_goal_data() -> dict[str, str]:
    """Provide sample goal data for tests."""
    return {
        "name": "Test Goal",
        "description": "A test goal description",
        "owner_type": "agent",
    }


def pytest_configure(config: pytest.Config) -> None:
    """Configure pytest to work without anchorpy dependencies."""
    # Unregister anchorpy plugin if it was loaded
    pm = config.pluginmanager
    if pm.has_plugin("anchorpy"):
        pm.unregister(name="anchorpy")
