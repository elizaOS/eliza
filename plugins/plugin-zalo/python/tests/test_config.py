"""Tests for plugin-zalo config module."""

import os

import pytest

from elizaos_plugin_zalo.config import (
    DEFAULT_WEBHOOK_PATH,
    DEFAULT_WEBHOOK_PORT,
    ZaloConfig,
)


class TestZaloConfigCreation:
    """Test ZaloConfig construction and defaults."""

    def test_create_with_required_fields(self) -> None:
        config = ZaloConfig(
            app_id="app",
            secret_key="secret",
            access_token="token",
        )
        assert config.app_id == "app"
        assert config.secret_key == "secret"
        assert config.access_token == "token"

    def test_defaults_webhook_path(self) -> None:
        config = ZaloConfig(
            app_id="a", secret_key="b", access_token="c"
        )
        assert config.webhook_path == DEFAULT_WEBHOOK_PATH

    def test_defaults_webhook_port(self) -> None:
        config = ZaloConfig(
            app_id="a", secret_key="b", access_token="c"
        )
        assert config.webhook_port == DEFAULT_WEBHOOK_PORT

    def test_defaults_use_polling_false(self) -> None:
        config = ZaloConfig(
            app_id="a", secret_key="b", access_token="c"
        )
        assert config.use_polling is False

    def test_defaults_enabled_true(self) -> None:
        config = ZaloConfig(
            app_id="a", secret_key="b", access_token="c"
        )
        assert config.enabled is True

    def test_optional_fields_default_none(self) -> None:
        config = ZaloConfig(
            app_id="a", secret_key="b", access_token="c"
        )
        assert config.refresh_token is None
        assert config.webhook_url is None
        assert config.proxy_url is None

    def test_custom_webhook_settings(self) -> None:
        config = ZaloConfig(
            app_id="a",
            secret_key="b",
            access_token="c",
            webhook_url="https://hook.example.com",
            webhook_path="/custom",
            webhook_port=8443,
        )
        assert config.webhook_url == "https://hook.example.com"
        assert config.webhook_path == "/custom"
        assert config.webhook_port == 8443


class TestZaloConfigUpdateMode:
    """Test update_mode property."""

    def test_polling_mode(self) -> None:
        config = ZaloConfig(
            app_id="a", secret_key="b", access_token="c", use_polling=True
        )
        assert config.update_mode == "polling"

    def test_webhook_mode(self) -> None:
        config = ZaloConfig(
            app_id="a", secret_key="b", access_token="c", use_polling=False
        )
        assert config.update_mode == "webhook"


class TestZaloConfigValidation:
    """Test validate_config method."""

    def test_valid_polling_config(self) -> None:
        config = ZaloConfig(
            app_id="a", secret_key="b", access_token="c", use_polling=True
        )
        # Should not raise
        config.validate_config()

    def test_valid_webhook_config(self) -> None:
        config = ZaloConfig(
            app_id="a",
            secret_key="b",
            access_token="c",
            webhook_url="https://example.com",
        )
        config.validate_config()

    def test_invalid_empty_app_id(self) -> None:
        config = ZaloConfig(app_id="", secret_key="b", access_token="c")
        with pytest.raises(ValueError, match="App ID"):
            config.validate_config()

    def test_invalid_empty_secret_key(self) -> None:
        config = ZaloConfig(app_id="a", secret_key="", access_token="c")
        with pytest.raises(ValueError, match="Secret key"):
            config.validate_config()

    def test_invalid_empty_access_token(self) -> None:
        config = ZaloConfig(app_id="a", secret_key="b", access_token="")
        with pytest.raises(ValueError, match="Access token"):
            config.validate_config()

    def test_invalid_webhook_without_url(self) -> None:
        config = ZaloConfig(
            app_id="a", secret_key="b", access_token="c", use_polling=False
        )
        with pytest.raises(ValueError, match="Webhook URL"):
            config.validate_config()


class TestZaloConfigFromEnv:
    """Test from_env class method."""

    def test_missing_app_id_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("ZALO_APP_ID", raising=False)
        monkeypatch.delenv("ZALO_SECRET_KEY", raising=False)
        monkeypatch.delenv("ZALO_ACCESS_TOKEN", raising=False)
        with pytest.raises(ValueError, match="ZALO_APP_ID"):
            ZaloConfig.from_env()

    def test_missing_secret_key_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ZALO_APP_ID", "app")
        monkeypatch.delenv("ZALO_SECRET_KEY", raising=False)
        monkeypatch.delenv("ZALO_ACCESS_TOKEN", raising=False)
        with pytest.raises(ValueError, match="ZALO_SECRET_KEY"):
            ZaloConfig.from_env()

    def test_missing_access_token_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ZALO_APP_ID", "app")
        monkeypatch.setenv("ZALO_SECRET_KEY", "secret")
        monkeypatch.delenv("ZALO_ACCESS_TOKEN", raising=False)
        with pytest.raises(ValueError, match="ZALO_ACCESS_TOKEN"):
            ZaloConfig.from_env()

    def test_loads_all_fields(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ZALO_APP_ID", "env-app")
        monkeypatch.setenv("ZALO_SECRET_KEY", "env-secret")
        monkeypatch.setenv("ZALO_ACCESS_TOKEN", "env-token")
        monkeypatch.setenv("ZALO_REFRESH_TOKEN", "env-refresh")
        monkeypatch.setenv("ZALO_USE_POLLING", "true")
        monkeypatch.setenv("ZALO_ENABLED", "false")

        config = ZaloConfig.from_env()
        assert config.app_id == "env-app"
        assert config.refresh_token == "env-refresh"
        assert config.use_polling is True
        assert config.enabled is False
