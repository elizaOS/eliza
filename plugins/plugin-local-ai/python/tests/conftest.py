"""Pytest configuration and fixtures."""

import pytest

from elizaos_plugin_local_ai import LocalAIConfig, LocalAIPlugin


@pytest.fixture
def config() -> LocalAIConfig:
    """Create a test configuration."""
    return LocalAIConfig(
        models_dir="/tmp/test_models",
        cache_dir="/tmp/test_cache",
    )


@pytest.fixture
def plugin(config: LocalAIConfig) -> LocalAIPlugin:
    """Create a test plugin instance."""
    return LocalAIPlugin(config)





