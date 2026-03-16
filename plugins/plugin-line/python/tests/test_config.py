"""Tests for LINE plugin configuration."""

import pytest

from elizaos_plugin_line.types import LineConfigurationError, LineSettings


def test_settings_defaults():
    """Default settings should have sensible values."""
    settings = LineSettings()
    assert settings.channel_access_token == ""
    assert settings.channel_secret == ""
    assert settings.webhook_path == "/webhooks/line"
    assert settings.dm_policy == "pairing"
    assert settings.group_policy == "allowlist"
    assert settings.allow_from == []
    assert settings.enabled is True


def test_settings_custom_values():
    """Settings should accept custom values."""
    settings = LineSettings(
        channel_access_token="test_token",
        channel_secret="test_secret",
        webhook_path="/custom/webhook",
        dm_policy="open",
        group_policy="disabled",
        allow_from=["U123", "U456"],
        enabled=False,
    )
    assert settings.channel_access_token == "test_token"
    assert settings.channel_secret == "test_secret"
    assert settings.webhook_path == "/custom/webhook"
    assert settings.dm_policy == "open"
    assert settings.group_policy == "disabled"
    assert settings.allow_from == ["U123", "U456"]
    assert settings.enabled is False


def test_validate_settings_valid():
    """Validation should pass with both token and secret."""
    from elizaos_plugin_line.service import LineService

    service = LineService()
    service.settings = LineSettings(
        channel_access_token="valid_token",
        channel_secret="valid_secret",
    )
    # Should not raise
    service._validate_settings()


def test_validate_settings_missing_token():
    """Validation should fail when access token is missing."""
    from elizaos_plugin_line.service import LineService

    service = LineService()
    service.settings = LineSettings(
        channel_access_token="",
        channel_secret="valid_secret",
    )
    with pytest.raises(LineConfigurationError, match="ACCESS_TOKEN"):
        service._validate_settings()


def test_validate_settings_missing_secret():
    """Validation should fail when channel secret is missing."""
    from elizaos_plugin_line.service import LineService

    service = LineService()
    service.settings = LineSettings(
        channel_access_token="valid_token",
        channel_secret="",
    )
    with pytest.raises(LineConfigurationError, match="SECRET"):
        service._validate_settings()


def test_validate_settings_none():
    """Validation should fail when settings is None."""
    from elizaos_plugin_line.service import LineService

    service = LineService()
    service.settings = None
    with pytest.raises(LineConfigurationError, match="not loaded"):
        service._validate_settings()


def test_configuration_error_fields():
    """LineConfigurationError should store setting name."""
    err = LineConfigurationError("Token missing", "LINE_CHANNEL_ACCESS_TOKEN")
    assert str(err) == "Token missing"
    assert err.code == "CONFIGURATION_ERROR"
    assert err.details["setting"] == "LINE_CHANNEL_ACCESS_TOKEN"


def test_configuration_error_without_setting():
    """LineConfigurationError should work without setting name."""
    err = LineConfigurationError("General error")
    assert str(err) == "General error"
    assert err.details == {}
