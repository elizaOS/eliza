"""Tests for WhatsApp plugin configuration."""

import os
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from elizaos_plugin_whatsapp.config import (
    WHATSAPP_API_BASE_URL,
    WhatsAppConfig,
    get_config_from_env,
)


class TestWhatsAppConfig:
    """Tests for WhatsAppConfig."""

    def test_create_with_required_fields(self) -> None:
        config = WhatsAppConfig(
            access_token="test-token",
            phone_number_id="123456789",
        )
        assert config.access_token == "test-token"
        assert config.phone_number_id == "123456789"

    def test_defaults(self) -> None:
        config = WhatsAppConfig(
            access_token="token",
            phone_number_id="phone-id",
        )
        assert config.api_version == "v17.0"
        assert config.enabled is True
        assert config.webhook_verify_token is None
        assert config.business_id is None

    def test_custom_values(self) -> None:
        config = WhatsAppConfig(
            access_token="token",
            phone_number_id="phone-id",
            webhook_verify_token="verify-token",
            business_id="biz-123",
            api_version="v18.0",
            enabled=False,
        )
        assert config.webhook_verify_token == "verify-token"
        assert config.business_id == "biz-123"
        assert config.api_version == "v18.0"
        assert config.enabled is False

    def test_api_base_url(self) -> None:
        config = WhatsAppConfig(
            access_token="token",
            phone_number_id="phone-id",
        )
        assert config.api_base_url == "https://graph.facebook.com/v17.0"

    def test_api_base_url_custom_version(self) -> None:
        config = WhatsAppConfig(
            access_token="token",
            phone_number_id="phone-id",
            api_version="v20.0",
        )
        assert config.api_base_url == "https://graph.facebook.com/v20.0"

    def test_validation_empty_access_token(self) -> None:
        with pytest.raises(ValidationError):
            WhatsAppConfig(
                access_token="",
                phone_number_id="phone-id",
            )

    def test_validation_empty_phone_number_id(self) -> None:
        with pytest.raises(ValidationError):
            WhatsAppConfig(
                access_token="token",
                phone_number_id="",
            )


class TestWhatsAppApiBaseUrl:
    """Tests for the API base URL constant."""

    def test_constant_value(self) -> None:
        assert WHATSAPP_API_BASE_URL == "https://graph.facebook.com/v17.0"


class TestGetConfigFromEnv:
    """Tests for get_config_from_env."""

    def test_returns_none_without_env_vars(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            result = get_config_from_env()
            assert result is None

    def test_returns_none_with_partial_env(self) -> None:
        with patch.dict(
            os.environ,
            {"WHATSAPP_ACCESS_TOKEN": "token"},
            clear=True,
        ):
            result = get_config_from_env()
            assert result is None

    def test_returns_config_with_required_env_vars(self) -> None:
        with patch.dict(
            os.environ,
            {
                "WHATSAPP_ACCESS_TOKEN": "test-token",
                "WHATSAPP_PHONE_NUMBER_ID": "123456",
            },
            clear=True,
        ):
            result = get_config_from_env()
            assert result is not None
            assert result.access_token == "test-token"
            assert result.phone_number_id == "123456"

    def test_reads_optional_env_vars(self) -> None:
        with patch.dict(
            os.environ,
            {
                "WHATSAPP_ACCESS_TOKEN": "token",
                "WHATSAPP_PHONE_NUMBER_ID": "phone",
                "WHATSAPP_WEBHOOK_TOKEN": "wh-token",
                "WHATSAPP_BUSINESS_ID": "biz-id",
            },
            clear=True,
        ):
            result = get_config_from_env()
            assert result is not None
            assert result.webhook_verify_token == "wh-token"
            assert result.business_id == "biz-id"

    def test_enabled_defaults_to_true(self) -> None:
        with patch.dict(
            os.environ,
            {
                "WHATSAPP_ACCESS_TOKEN": "token",
                "WHATSAPP_PHONE_NUMBER_ID": "phone",
            },
            clear=True,
        ):
            result = get_config_from_env()
            assert result is not None
            assert result.enabled is True

    def test_enabled_can_be_false(self) -> None:
        with patch.dict(
            os.environ,
            {
                "WHATSAPP_ACCESS_TOKEN": "token",
                "WHATSAPP_PHONE_NUMBER_ID": "phone",
                "WHATSAPP_ENABLED": "false",
            },
            clear=True,
        ):
            result = get_config_from_env()
            assert result is not None
            assert result.enabled is False
