import pytest

from elizaos_plugin_local_ai import LocalAIConfig, LocalAIPlugin


@pytest.fixture
def config() -> LocalAIConfig:
    return LocalAIConfig(
        models_dir="/tmp/test_models",
        cache_dir="/tmp/test_cache",
    )


@pytest.fixture
def plugin(config: LocalAIConfig) -> LocalAIPlugin:
    return LocalAIPlugin(config)
