import pytest

from elizaos_plugin_roblox.config import RobloxConfig
from elizaos_plugin_roblox.error import ConfigError


def test_config_creation() -> None:
    config = RobloxConfig(
        api_key="test-key",
        universe_id="12345",
    )
    assert config.api_key == "test-key"
    assert config.universe_id == "12345"
    assert config.messaging_topic == "eliza-agent"
    assert config.poll_interval == 30
    assert not config.dry_run


def test_config_with_options() -> None:
    config = RobloxConfig(
        api_key="test-key",
        universe_id="12345",
        place_id="67890",
        messaging_topic="custom-topic",
        poll_interval=60,
        dry_run=True,
    )
    assert config.place_id == "67890"
    assert config.messaging_topic == "custom-topic"
    assert config.poll_interval == 60
    assert config.dry_run


def test_config_validation_empty_api_key() -> None:
    config = RobloxConfig(api_key="", universe_id="12345")
    with pytest.raises(ConfigError):
        config.validate()


def test_config_validation_empty_universe_id() -> None:
    config = RobloxConfig(api_key="test-key", universe_id="")
    with pytest.raises(ConfigError):
        config.validate()


def test_config_validation_success() -> None:
    config = RobloxConfig(api_key="test-key", universe_id="12345")
    config.validate()
