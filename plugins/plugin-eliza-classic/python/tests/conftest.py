"""Pytest configuration for ELIZA Classic Plugin tests."""

import pytest

from elizaos_plugin_eliza_classic import ElizaClassicPlugin


@pytest.fixture
def plugin() -> ElizaClassicPlugin:
    """Create a fresh plugin instance for each test."""
    return ElizaClassicPlugin()

