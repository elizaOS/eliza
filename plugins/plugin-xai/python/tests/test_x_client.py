"""Tests for X client."""

import os
from unittest.mock import patch

import pytest

from elizaos_plugin_xai.client import TwitterClient, XClientError
from elizaos_plugin_xai.types import AuthMode, TwitterConfig


# ============================================================================
# TwitterConfig
# ============================================================================


class TestTwitterConfig:
    """Tests for TwitterConfig."""

    def test_defaults(self) -> None:
        config = TwitterConfig()
        assert config.auth_mode == AuthMode.ENV
        assert config.max_post_length == 280
        assert config.dry_run is False
        assert config.enable_post is False
        assert config.enable_replies is True
        assert config.enable_actions is False
        assert config.retry_limit == 5
        assert config.timeout == 30.0

    def test_env_auth_mode(self) -> None:
        config = TwitterConfig(
            auth_mode=AuthMode.ENV,
            api_key="key",
            api_secret="secret",
            access_token="token",
            access_token_secret="token_secret",
        )
        assert config.auth_mode == AuthMode.ENV
        config.validate_credentials()  # Should not raise

    def test_bearer_auth_mode(self) -> None:
        config = TwitterConfig(
            auth_mode=AuthMode.BEARER,
            bearer_token="my-bearer-token",
        )
        assert config.auth_mode == AuthMode.BEARER
        config.validate_credentials()  # Should not raise

    def test_oauth_auth_mode(self) -> None:
        config = TwitterConfig(
            auth_mode=AuthMode.OAUTH,
            client_id="cid",
            redirect_uri="https://example.com/cb",
        )
        assert config.auth_mode == AuthMode.OAUTH
        config.validate_credentials()  # Should not raise

    def test_dry_run_mode(self) -> None:
        config = TwitterConfig(dry_run=True)
        assert config.dry_run is True

    def test_from_env_defaults(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = TwitterConfig.from_env()
            assert config.auth_mode == AuthMode.ENV
            assert config.dry_run is False

    def test_from_env_custom(self) -> None:
        with patch.dict(
            os.environ,
            {
                "X_AUTH_MODE": "bearer",
                "X_BEARER_TOKEN": "my-token",
                "X_DRY_RUN": "true",
                "X_ENABLE_POST": "true",
                "X_MAX_POST_LENGTH": "500",
            },
            clear=True,
        ):
            config = TwitterConfig.from_env()
            assert config.auth_mode == AuthMode.BEARER
            assert config.bearer_token == "my-token"
            assert config.dry_run is True
            assert config.enable_post is True
            assert config.max_post_length == 500

    def test_validate_env_missing_credentials(self) -> None:
        config = TwitterConfig(auth_mode=AuthMode.ENV)
        with pytest.raises(ValueError, match="Missing credentials"):
            config.validate_credentials()

    def test_validate_bearer_missing_token(self) -> None:
        config = TwitterConfig(auth_mode=AuthMode.BEARER)
        with pytest.raises(ValueError, match="bearer_token"):
            config.validate_credentials()

    def test_validate_oauth_missing_client_id(self) -> None:
        config = TwitterConfig(auth_mode=AuthMode.OAUTH)
        with pytest.raises(ValueError, match="client_id"):
            config.validate_credentials()

    def test_enable_features(self) -> None:
        config = TwitterConfig(
            enable_post=True,
            enable_replies=False,
            enable_actions=True,
        )
        assert config.enable_post is True
        assert config.enable_replies is False
        assert config.enable_actions is True


# ============================================================================
# XClientError
# ============================================================================


class TestXClientError:
    """Tests for XClientError."""

    def test_construction(self) -> None:
        err = XClientError("API error", status_code=429)
        assert str(err) == "API error"
        assert err.status_code == 429

    def test_without_status_code(self) -> None:
        err = XClientError("Unknown")
        assert err.status_code is None

    def test_is_exception(self) -> None:
        err = XClientError("test")
        assert isinstance(err, Exception)


# ============================================================================
# TwitterClient
# ============================================================================


class TestTwitterClient:
    """Tests for TwitterClient."""

    @pytest.fixture
    def x_config(self) -> TwitterConfig:
        return TwitterConfig(
            auth_mode=AuthMode.ENV,
            api_key="test_key",
            api_secret="test_secret",
            access_token="test_token",
            access_token_secret="test_token_secret",
        )

    @pytest.mark.asyncio
    async def test_client_creation(self, x_config: TwitterConfig) -> None:
        client = TwitterClient(x_config)
        assert client is not None
        await client.close()

    @pytest.mark.asyncio
    async def test_client_context_manager(self, x_config: TwitterConfig) -> None:
        async with TwitterClient(x_config) as client:
            assert client is not None

    @pytest.mark.asyncio
    async def test_close_idempotent(self, x_config: TwitterConfig) -> None:
        client = TwitterClient(x_config)
        await client.close()
        await client.close()  # Should not raise

    def test_api_base(self) -> None:
        assert TwitterClient.API_BASE == "https://api.x.com/2"

    def test_bearer_auth_headers(self) -> None:
        config = TwitterConfig(
            auth_mode=AuthMode.BEARER,
            bearer_token="my-bearer",
        )
        client = TwitterClient(config)
        headers = client._get_headers()
        assert headers["Authorization"] == "Bearer my-bearer"
        assert headers["Content-Type"] == "application/json"

    def test_no_auth_raises(self) -> None:
        config = TwitterConfig(auth_mode=AuthMode.OAUTH, client_id="cid", redirect_uri="uri")
        client = TwitterClient(config)
        with pytest.raises(XClientError, match="No valid authentication"):
            client._get_headers()
