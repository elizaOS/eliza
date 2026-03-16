"""Tests for Copilot Proxy service, client helpers, and JSON extraction."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from elizaos_plugin_copilot_proxy.client import (
    CopilotProxyClientError,
    _extract_json,
)
from elizaos_plugin_copilot_proxy.config import CopilotProxyConfig
from elizaos_plugin_copilot_proxy.service import CopilotProxyService, get_service
from elizaos_plugin_copilot_proxy.types import (
    TextGenerationParams,
    TextGenerationResult,
    TokenUsage,
)


# ── CopilotProxyService tests ───────────────────────────────────


class TestCopilotProxyServiceCreation:
    def test_creation_with_config(self, config: CopilotProxyConfig) -> None:
        service = CopilotProxyService(config)
        assert service.small_model == "gpt-5-mini"
        assert service.large_model == "gpt-5.1"

    def test_not_available_when_not_initialized(self, config: CopilotProxyConfig) -> None:
        service = CopilotProxyService(config)
        assert service.is_available is False

    def test_get_client_raises_when_not_initialized(self, config: CopilotProxyConfig) -> None:
        service = CopilotProxyService(config)
        with pytest.raises(CopilotProxyClientError, match="Service not initialized"):
            service._get_client()

    def test_context_window_property(self, config: CopilotProxyConfig) -> None:
        service = CopilotProxyService(config)
        assert service.context_window == config.context_window

    def test_max_tokens_property(self, config: CopilotProxyConfig) -> None:
        service = CopilotProxyService(config)
        assert service.max_tokens == config.max_tokens


class TestCopilotProxyServiceInitialize:
    async def test_initialize_disabled_raises(
        self, disabled_config: CopilotProxyConfig
    ) -> None:
        service = CopilotProxyService(disabled_config)
        with pytest.raises(CopilotProxyClientError, match="Plugin is disabled"):
            await service.initialize()

    async def test_initialize_with_healthy_server(
        self, config: CopilotProxyConfig
    ) -> None:
        with patch(
            "elizaos_plugin_copilot_proxy.service.CopilotProxyClient"
        ) as mock_cls:
            mock_client = AsyncMock()
            mock_client.health_check.return_value = True
            mock_cls.return_value = mock_client

            service = CopilotProxyService(config)
            await service.initialize()

            assert service.is_available is True
            mock_client.health_check.assert_awaited_once()

    async def test_initialize_with_unhealthy_server_still_initializes(
        self, config: CopilotProxyConfig
    ) -> None:
        with patch(
            "elizaos_plugin_copilot_proxy.service.CopilotProxyClient"
        ) as mock_cls:
            mock_client = AsyncMock()
            mock_client.health_check.return_value = False
            mock_cls.return_value = mock_client

            service = CopilotProxyService(config)
            await service.initialize()

            assert service.is_available is True

    async def test_initialize_skips_if_already_initialized(
        self, config: CopilotProxyConfig
    ) -> None:
        with patch(
            "elizaos_plugin_copilot_proxy.service.CopilotProxyClient"
        ) as mock_cls:
            mock_client = AsyncMock()
            mock_client.health_check.return_value = True
            mock_cls.return_value = mock_client

            service = CopilotProxyService(config)
            await service.initialize()
            await service.initialize()  # second call is a no-op

            mock_cls.assert_called_once()


class TestCopilotProxyServiceGeneration:
    async def test_generate_text_delegates_to_client(
        self, config: CopilotProxyConfig
    ) -> None:
        with patch(
            "elizaos_plugin_copilot_proxy.service.CopilotProxyClient"
        ) as mock_cls:
            mock_client = AsyncMock()
            mock_client.health_check.return_value = True
            expected = TextGenerationResult(text="Hello world")
            mock_client.generate_text.return_value = expected
            mock_cls.return_value = mock_client

            service = CopilotProxyService(config)
            await service.initialize()

            params = TextGenerationParams(prompt="Say hello")
            result = await service.generate_text(params)

            assert result.text == "Hello world"
            mock_client.generate_text.assert_awaited_once_with(params)

    async def test_generate_text_small(self, config: CopilotProxyConfig) -> None:
        with patch(
            "elizaos_plugin_copilot_proxy.service.CopilotProxyClient"
        ) as mock_cls:
            mock_client = AsyncMock()
            mock_client.health_check.return_value = True
            mock_client.generate_text_small.return_value = "Small response"
            mock_cls.return_value = mock_client

            service = CopilotProxyService(config)
            await service.initialize()

            result = await service.generate_text_small("Say hi")
            assert result == "Small response"

    async def test_generate_text_large(self, config: CopilotProxyConfig) -> None:
        with patch(
            "elizaos_plugin_copilot_proxy.service.CopilotProxyClient"
        ) as mock_cls:
            mock_client = AsyncMock()
            mock_client.health_check.return_value = True
            mock_client.generate_text_large.return_value = "Large response"
            mock_cls.return_value = mock_client

            service = CopilotProxyService(config)
            await service.initialize()

            result = await service.generate_text_large("Write something")
            assert result == "Large response"


class TestCopilotProxyServiceShutdown:
    async def test_shutdown_clears_state(self, config: CopilotProxyConfig) -> None:
        with patch(
            "elizaos_plugin_copilot_proxy.service.CopilotProxyClient"
        ) as mock_cls:
            mock_client = AsyncMock()
            mock_client.health_check.return_value = True
            mock_cls.return_value = mock_client

            service = CopilotProxyService(config)
            await service.initialize()
            assert service.is_available is True

            await service.shutdown()
            assert service.is_available is False


# ── get_service singleton test ───────────────────────────────────


class TestGetService:
    def test_returns_singleton(self) -> None:
        import elizaos_plugin_copilot_proxy.service as svc_mod

        svc_mod._service = None  # Reset global

        svc1 = get_service()
        svc2 = get_service()
        assert svc1 is svc2

        svc_mod._service = None  # Cleanup


# ── _extract_json tests ──────────────────────────────────────────


class TestExtractJson:
    def test_direct_json_object(self) -> None:
        result = _extract_json('{"key": "value", "num": 42}')
        assert result == {"key": "value", "num": 42}

    def test_json_from_json_code_block(self) -> None:
        text = 'Here is the result:\n```json\n{"name": "test"}\n```\nDone.'
        result = _extract_json(text)
        assert result == {"name": "test"}

    def test_json_from_generic_code_block(self) -> None:
        text = 'Output:\n```\n{"status": "ok"}\n```'
        result = _extract_json(text)
        assert result == {"status": "ok"}

    def test_json_embedded_in_prose(self) -> None:
        text = 'The answer is {"answer": true} as shown.'
        result = _extract_json(text)
        assert result == {"answer": True}

    def test_invalid_text_raises(self) -> None:
        with pytest.raises(CopilotProxyClientError, match="Could not extract valid JSON"):
            _extract_json("no json here at all")

    def test_non_dict_json_raises(self) -> None:
        with pytest.raises(CopilotProxyClientError, match="Could not extract valid JSON"):
            _extract_json("[1, 2, 3]")
