import pytest

from elizaos_plugin_bluesky import BlueSkyConfig
from elizaos_plugin_bluesky.errors import ConfigError


class TestBlueSkyConfig:
    def test_create_config_with_valid_handle(self, mock_config: dict[str, str]) -> None:
        config = BlueSkyConfig(
            handle=mock_config["handle"],
            password=mock_config["password"],
        )
        assert config.handle == mock_config["handle"]
        assert config.password == mock_config["password"]
        assert config.service == "https://bsky.social"

    def test_create_config_with_custom_service(self, mock_config: dict[str, str]) -> None:
        config = BlueSkyConfig(
            handle=mock_config["handle"],
            password=mock_config["password"],
            service="https://custom.bsky.social",
        )
        assert config.service == "https://custom.bsky.social"

    def test_create_config_empty_handle_raises(self, mock_config: dict[str, str]) -> None:
        with pytest.raises(ConfigError) as exc_info:
            BlueSkyConfig(handle="", password=mock_config["password"])
        assert "Handle cannot be empty" in str(exc_info.value)

    def test_create_config_invalid_handle_raises(self, mock_config: dict[str, str]) -> None:
        with pytest.raises(ConfigError) as exc_info:
            BlueSkyConfig(handle="invalid", password=mock_config["password"])
        assert "Invalid handle format" in str(exc_info.value)

    def test_create_config_empty_password_raises(self, mock_config: dict[str, str]) -> None:
        with pytest.raises(ConfigError) as exc_info:
            BlueSkyConfig(handle=mock_config["handle"], password="")
        assert "Password cannot be empty" in str(exc_info.value)

    def test_create_config_with_dry_run(self, mock_config: dict[str, str]) -> None:
        config = BlueSkyConfig(
            handle=mock_config["handle"],
            password=mock_config["password"],
            dry_run=True,
        )
        assert config.dry_run is True

    def test_create_config_default_values(self, mock_config: dict[str, str]) -> None:
        config = BlueSkyConfig(
            handle=mock_config["handle"],
            password=mock_config["password"],
        )
        assert config.dry_run is False
        assert config.poll_interval == 60
        assert config.enable_posting is True
        assert config.enable_dms is True
