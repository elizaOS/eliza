"""Tests for Google Chat plugin configuration and service validation."""

import os

import pytest

from elizaos_plugin_google_chat.types import (
    GoogleChatConfigurationError,
    GoogleChatSettings,
)
from elizaos_plugin_google_chat.service import GoogleChatService


class TestGoogleChatServiceValidation:
    """Test the service validation logic without credentials."""

    def test_validate_missing_credentials_and_env(self, monkeypatch):
        """Validation should fail when no credentials are configured."""
        monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
        monkeypatch.delenv("GOOGLE_CHAT_SERVICE_ACCOUNT", raising=False)
        monkeypatch.delenv("GOOGLE_CHAT_SERVICE_ACCOUNT_FILE", raising=False)

        service = GoogleChatService()
        service.settings = GoogleChatSettings(
            service_account=None,
            service_account_file=None,
            audience_type="app-url",
            audience="https://test.example.com",
        )

        with pytest.raises(GoogleChatConfigurationError) as exc_info:
            service._validate_settings()

        assert "service account" in str(exc_info.value).lower()

    def test_validate_missing_audience(self):
        """Validation should fail when audience is empty."""
        service = GoogleChatService()
        service.settings = GoogleChatSettings(
            service_account='{"type": "service_account"}',
            audience_type="app-url",
            audience="",
        )

        with pytest.raises(GoogleChatConfigurationError) as exc_info:
            service._validate_settings()

        assert "GOOGLE_CHAT_AUDIENCE" in str(exc_info.value)

    def test_validate_invalid_audience_type(self):
        """Validation should fail for invalid audience type."""
        service = GoogleChatService()
        service.settings = GoogleChatSettings(
            service_account='{"type": "service_account"}',
            audience_type="invalid-type",
            audience="https://test.example.com",
        )

        with pytest.raises(GoogleChatConfigurationError) as exc_info:
            service._validate_settings()

        assert "GOOGLE_CHAT_AUDIENCE_TYPE" in str(exc_info.value)

    def test_validate_valid_with_service_account(self):
        """Validation should pass with service account credentials."""
        service = GoogleChatService()
        service.settings = GoogleChatSettings(
            service_account='{"type": "service_account"}',
            audience_type="app-url",
            audience="https://test.example.com",
        )

        # Should not raise
        service._validate_settings()

    def test_validate_valid_with_service_account_file(self):
        """Validation should pass with service account file."""
        service = GoogleChatService()
        service.settings = GoogleChatSettings(
            service_account_file="/path/to/key.json",
            audience_type="project-number",
            audience="123456789",
        )

        # Should not raise
        service._validate_settings()

    def test_validate_valid_with_env_credentials(self, monkeypatch):
        """Validation should pass with GOOGLE_APPLICATION_CREDENTIALS env var."""
        monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "/path/to/default.json")

        service = GoogleChatService()
        service.settings = GoogleChatSettings(
            service_account=None,
            service_account_file=None,
            audience_type="app-url",
            audience="https://test.example.com",
        )

        # Should not raise
        service._validate_settings()

    def test_validate_no_settings(self):
        """Validation should fail when settings are not loaded."""
        service = GoogleChatService()
        service.settings = None

        with pytest.raises(GoogleChatConfigurationError) as exc_info:
            service._validate_settings()

        assert "not loaded" in str(exc_info.value).lower()


class TestGoogleChatSettingsWebhookPath:
    """Test webhook path normalization in settings."""

    def test_webhook_path_with_leading_slash(self):
        settings = GoogleChatSettings(webhook_path="/googlechat")
        assert settings.webhook_path == "/googlechat"

    def test_default_webhook_path(self):
        settings = GoogleChatSettings()
        assert settings.webhook_path == "/googlechat"


class TestGoogleChatSettingsSpaces:
    """Test spaces configuration in settings."""

    def test_empty_spaces(self):
        settings = GoogleChatSettings(spaces=[])
        assert settings.spaces == []

    def test_multiple_spaces(self):
        settings = GoogleChatSettings(spaces=["spaces/A", "spaces/B", "spaces/C"])
        assert len(settings.spaces) == 3
        assert "spaces/A" in settings.spaces
        assert "spaces/B" in settings.spaces
        assert "spaces/C" in settings.spaces


class TestGoogleChatServiceState:
    """Test service state management."""

    def test_initial_state(self):
        service = GoogleChatService()
        assert service.is_connected() is False
        assert service.get_bot_user() is None
        assert service.get_settings() is None

    def test_connected_state_after_settings(self):
        service = GoogleChatService()
        service.settings = GoogleChatSettings(
            service_account='{"type": "service_account"}',
            audience_type="app-url",
            audience="https://test.example.com",
            bot_user="users/bot123",
        )
        assert service.get_bot_user() == "users/bot123"
        assert service.get_settings() is not None
