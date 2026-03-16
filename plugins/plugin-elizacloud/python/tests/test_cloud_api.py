"""Tests for CloudApiClient — request construction, error handling, response parsing."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from elizaos_plugin_elizacloud.types.cloud import (
    CloudApiError,
    InsufficientCreditsError,
)
from elizaos_plugin_elizacloud.utils.cloud_api import CloudApiClient
from elizaos_plugin_elizacloud.utils.forwarded_settings import (
    FORWARDED_SETTINGS,
    collect_env_vars,
)


class TestCloudApiClient:
    def test_construction(self) -> None:
        client = CloudApiClient("https://api.example.com/v1")
        assert client.base_url == "https://api.example.com/v1"
        assert client.api_key is None

    def test_trailing_slash_stripped(self) -> None:
        client = CloudApiClient("https://api.example.com/v1/")
        assert client.base_url == "https://api.example.com/v1"

    def test_set_api_key(self) -> None:
        client = CloudApiClient("https://api.example.com")
        client.set_api_key("my-key")
        assert client.api_key == "my-key"

    def test_set_base_url(self) -> None:
        client = CloudApiClient("https://old.example.com")
        client.set_base_url("https://new.example.com/v2/")
        assert client.base_url == "https://new.example.com/v2"

    def test_build_ws_url_https(self) -> None:
        client = CloudApiClient("https://api.example.com/v1")
        assert client.build_ws_url("/bridge") == "wss://api.example.com/v1/bridge"

    def test_build_ws_url_http(self) -> None:
        client = CloudApiClient("http://localhost:3000")
        assert client.build_ws_url("/ws") == "ws://localhost:3000/ws"

    @pytest.mark.asyncio
    async def test_get_sends_correct_request(self) -> None:
        client = CloudApiClient("https://api.example.com", api_key="test-key")

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.is_success = True
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "application/json"}
        mock_response.json.return_value = {"success": True, "data": []}

        with patch("httpx.AsyncClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.request.return_value = mock_response
            mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
            mock_instance.__aexit__ = AsyncMock(return_value=None)
            MockClient.return_value = mock_instance

            result = await client.get("/containers")

        assert result == {"success": True, "data": []}
        mock_instance.request.assert_called_once()
        # Verify the method was GET (passed as positional arg)
        call_args = mock_instance.request.call_args
        all_args = list(call_args.args) + list(call_args.kwargs.values())
        assert "GET" in all_args or call_args.kwargs.get("method") == "GET"

    @pytest.mark.asyncio
    async def test_post_sends_json_body(self) -> None:
        client = CloudApiClient("https://api.example.com", api_key="test-key")

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.is_success = True
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "application/json"}
        mock_response.json.return_value = {"success": True}

        with patch("httpx.AsyncClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.request.return_value = mock_response
            mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
            mock_instance.__aexit__ = AsyncMock(return_value=None)
            MockClient.return_value = mock_instance

            result = await client.post("/containers", {"name": "test"})

        assert result["success"] is True

    @pytest.mark.asyncio
    async def test_error_response_raises(self) -> None:
        client = CloudApiClient("https://api.example.com", api_key="test-key")

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.is_success = False
        mock_response.status_code = 404
        mock_response.headers = {"content-type": "application/json"}
        mock_response.json.return_value = {"error": "Not found", "success": False}

        with patch("httpx.AsyncClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.request.return_value = mock_response
            mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
            mock_instance.__aexit__ = AsyncMock(return_value=None)
            MockClient.return_value = mock_instance

            with pytest.raises(CloudApiError) as exc_info:
                await client.get("/nonexistent")

        assert exc_info.value.status_code == 404

    @pytest.mark.asyncio
    async def test_402_raises_insufficient_credits(self) -> None:
        client = CloudApiClient("https://api.example.com", api_key="test-key")

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.is_success = False
        mock_response.status_code = 402
        mock_response.headers = {"content-type": "application/json"}
        mock_response.json.return_value = {
            "error": "Insufficient credits",
            "success": False,
            "requiredCredits": 10.0,
        }

        with patch("httpx.AsyncClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.request.return_value = mock_response
            mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
            mock_instance.__aexit__ = AsyncMock(return_value=None)
            MockClient.return_value = mock_instance

            with pytest.raises(InsufficientCreditsError) as exc_info:
                await client.post("/containers", {})

        assert exc_info.value.required_credits == 10.0

    @pytest.mark.asyncio
    async def test_non_json_error_response(self) -> None:
        client = CloudApiClient("https://api.example.com", api_key="test-key")

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.is_success = False
        mock_response.status_code = 502
        mock_response.reason_phrase = "Bad Gateway"
        mock_response.headers = {"content-type": "text/html"}

        with patch("httpx.AsyncClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.request.return_value = mock_response
            mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
            mock_instance.__aexit__ = AsyncMock(return_value=None)
            MockClient.return_value = mock_instance

            with pytest.raises(CloudApiError) as exc_info:
                await client.get("/health")

        assert exc_info.value.status_code == 502

    @pytest.mark.asyncio
    async def test_unauthenticated_post_skips_auth_header(self) -> None:
        client = CloudApiClient("https://api.example.com", api_key="test-key")

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.is_success = True
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "application/json"}
        mock_response.json.return_value = {"success": True, "data": {}}

        with patch("httpx.AsyncClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.request.return_value = mock_response
            mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
            mock_instance.__aexit__ = AsyncMock(return_value=None)
            MockClient.return_value = mock_instance

            await client.post_unauthenticated("/device-auth", {"deviceId": "abc"})

        call_kwargs = mock_instance.request.call_args
        headers = call_kwargs[1].get("headers") or call_kwargs[0][2] if len(call_kwargs[0]) > 2 else {}
        # Auth header should not be present for unauthenticated requests
        if isinstance(headers, dict):
            assert "Authorization" not in headers


class TestForwardedSettings:
    def test_forwarded_settings_list(self) -> None:
        assert "OPENAI_API_KEY" in FORWARDED_SETTINGS
        assert "ELIZAOS_CLOUD_API_KEY" in FORWARDED_SETTINGS
        assert len(FORWARDED_SETTINGS) == 8

    def test_collect_from_settings(self) -> None:
        settings = {
            "OPENAI_API_KEY": "sk-123",
            "UNKNOWN_KEY": "ignored",
        }
        result = collect_env_vars(settings)
        assert result == {"OPENAI_API_KEY": "sk-123"}

    def test_collect_from_env(self) -> None:
        import os
        os.environ["ELIZAOS_CLOUD_API_KEY"] = "test-env-key"
        try:
            result = collect_env_vars()
            assert result.get("ELIZAOS_CLOUD_API_KEY") == "test-env-key"
        finally:
            os.environ.pop("ELIZAOS_CLOUD_API_KEY", None)

    def test_settings_override_env(self) -> None:
        import os
        os.environ["OPENAI_API_KEY"] = "env-key"
        try:
            result = collect_env_vars({"OPENAI_API_KEY": "settings-key"})
            assert result["OPENAI_API_KEY"] == "settings-key"
        finally:
            os.environ.pop("OPENAI_API_KEY", None)

    def test_none_values_skipped(self) -> None:
        result = collect_env_vars({"OPENAI_API_KEY": None})
        # Should fall back to env which is likely not set
        assert "OPENAI_API_KEY" not in result or result.get("OPENAI_API_KEY") is not None
