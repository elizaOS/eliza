"""
Unit tests for the Python Plugin Starter.

These tests use pytest and mock the runtime to test individual components
in isolation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from elizaos_plugin_starter.plugin import (
    StarterService,
    hello_python_action,
    hello_python_handler,
    hello_python_validate,
    plugin,
    plugin_init,
    python_info_get,
    python_info_provider,
)


class TestPluginConfiguration:
    """Tests for plugin configuration and metadata."""

    def test_plugin_has_required_metadata(self) -> None:
        """Test that plugin has required metadata."""
        assert plugin.name == "python-plugin-starter"
        assert plugin.description is not None
        assert len(plugin.description) > 0

    def test_plugin_has_actions(self) -> None:
        """Test that plugin has actions."""
        assert plugin.actions is not None
        assert len(plugin.actions) > 0
        assert hello_python_action in plugin.actions

    def test_plugin_has_providers(self) -> None:
        """Test that plugin has providers."""
        assert plugin.providers is not None
        assert len(plugin.providers) > 0
        assert python_info_provider in plugin.providers

    def test_plugin_has_services(self) -> None:
        """Test that plugin has services."""
        assert plugin.services is not None
        assert len(plugin.services) > 0
        assert StarterService in plugin.services

    def test_plugin_has_init_function(self) -> None:
        """Test that plugin has init function."""
        assert plugin.init is not None
        assert plugin.init == plugin_init

    @pytest.mark.asyncio
    async def test_plugin_init_with_config(self) -> None:
        """Test plugin initialization with configuration."""
        runtime = MagicMock()
        config = {"EXAMPLE_PLUGIN_VARIABLE": "test-value"}

        await plugin_init(config, runtime)

        # Init should not raise
        assert True

    @pytest.mark.asyncio
    async def test_plugin_init_without_config(self) -> None:
        """Test plugin initialization without configuration."""
        runtime = MagicMock()
        config = {}

        await plugin_init(config, runtime)

        # Init should not raise
        assert True


class TestHelloPythonAction:
    """Tests for the HELLO_PYTHON action."""

    def test_action_exists(self) -> None:
        """Test that hello_python_action exists."""
        assert hello_python_action is not None
        assert hello_python_action.name == "HELLO_PYTHON"

    def test_action_has_description(self) -> None:
        """Test that action has description."""
        assert hello_python_action.description is not None
        assert len(hello_python_action.description) > 0

    def test_action_has_validate(self) -> None:
        """Test that action has validate function."""
        assert hello_python_action.validate_fn is not None
        assert hello_python_action.validate_fn == hello_python_validate

    def test_action_has_handler(self) -> None:
        """Test that action has handler function."""
        assert hello_python_action.handler is not None
        assert hello_python_action.handler == hello_python_handler

    @pytest.mark.asyncio
    async def test_action_validate_always_returns_true(self) -> None:
        """Test that validate always returns True (current implementation)."""
        runtime = MagicMock()
        message = MagicMock()
        message.content = MagicMock()
        message.content.text = "hello"

        result = await hello_python_validate(runtime, message, None)
        assert result is True

    @pytest.mark.asyncio
    async def test_action_validate_without_text(self) -> None:
        """Test validate with message without text content."""
        runtime = MagicMock()
        message = MagicMock()
        message.content = None

        result = await hello_python_validate(runtime, message, None)
        assert result is True

    @pytest.mark.asyncio
    async def test_action_handler_with_callback(self) -> None:
        """Test action handler with callback."""
        runtime = MagicMock()
        message = MagicMock()
        message.content = MagicMock()
        message.content.text = "friend"
        message.content.source = "test"

        callback_called = False
        callback_content = None

        async def callback(content: dict) -> list:
            nonlocal callback_called, callback_content
            callback_called = True
            callback_content = content
            return []

        result = await hello_python_handler(
            runtime, message, None, None, callback, None
        )

        assert result is not None
        assert result.success is True
        assert "Hello from Python" in result.text
        assert "friend" in result.text
        assert callback_called is True
        assert callback_content is not None
        assert callback_content["text"] == result.text
        assert "HELLO_PYTHON" in callback_content["actions"]

    @pytest.mark.asyncio
    async def test_action_handler_without_callback(self) -> None:
        """Test action handler without callback."""
        runtime = MagicMock()
        message = MagicMock()
        message.content = MagicMock()
        message.content.text = "world"

        result = await hello_python_handler(
            runtime, message, None, None, None, None
        )

        assert result is not None
        assert result.success is True
        assert "Hello from Python" in result.text
        assert "world" in result.text

    @pytest.mark.asyncio
    async def test_action_handler_without_content(self) -> None:
        """Test action handler with message without content."""
        runtime = MagicMock()
        message = MagicMock()
        message.content = None

        result = await hello_python_handler(
            runtime, message, None, None, None, None
        )

        assert result is not None
        assert result.success is True
        assert "Hello from Python" in result.text
        assert "friend" in result.text  # Default fallback

    @pytest.mark.asyncio
    async def test_action_handler_error_handling(self) -> None:
        """Test action handler error handling."""
        runtime = MagicMock()
        message = MagicMock()
        message.content = MagicMock()

        # Make callback raise an error
        async def error_callback(_content: dict) -> list:
            raise Exception("Callback error")

        result = await hello_python_handler(
            runtime, message, None, None, error_callback, None
        )

        # Handler should catch the error and return failure
        assert result is not None
        assert result.success is False
        assert result.error is not None


class TestPythonInfoProvider:
    """Tests for the PYTHON_INFO provider."""

    def test_provider_exists(self) -> None:
        """Test that python_info_provider exists."""
        assert python_info_provider is not None
        assert python_info_provider.name == "PYTHON_INFO"

    def test_provider_has_description(self) -> None:
        """Test that provider has description."""
        assert python_info_provider.description is not None
        assert len(python_info_provider.description) > 0

    def test_provider_has_get_function(self) -> None:
        """Test that provider has get function."""
        assert python_info_provider.get is not None
        assert python_info_provider.get == python_info_get

    @pytest.mark.asyncio
    async def test_provider_get_returns_data(self) -> None:
        """Test that provider get returns data."""
        runtime = MagicMock()
        message = MagicMock()
        state = MagicMock()

        result = await python_info_get(runtime, message, state)

        assert result is not None
        assert result.text is not None
        assert len(result.text) > 0
        assert "Python" in result.text
        assert result.values is not None
        assert "language" in result.values
        assert result.values["language"] == "python"
        assert result.data is not None
        assert "runtime_info" in result.data


class TestStarterService:
    """Tests for the StarterService."""

    def test_service_has_correct_type(self) -> None:
        """Test that service has correct type."""
        assert StarterService.service_type == "python-starter"

    @pytest.mark.asyncio
    async def test_service_start(self) -> None:
        """Test service start method."""
        runtime = MagicMock()

        service = await StarterService.start(runtime)

        assert service is not None
        assert isinstance(service, StarterService)
        assert service.initialized is True

    @pytest.mark.asyncio
    async def test_service_stop(self) -> None:
        """Test service stop method."""
        runtime = MagicMock()
        service = await StarterService.start(runtime)

        assert service.initialized is True

        await service.stop()

        assert service.initialized is False

    @pytest.mark.asyncio
    async def test_service_increment_requests(self) -> None:
        """Test service increment_requests method."""
        runtime = MagicMock()
        service = await StarterService.start(runtime)

        assert service.request_count == 0

        count1 = service.increment_requests()
        assert count1 == 1
        assert service.request_count == 1

        count2 = service.increment_requests()
        assert count2 == 2
        assert service.request_count == 2

    def test_service_capability_description(self) -> None:
        """Test service capability description."""
        runtime = MagicMock()
        service = StarterService(runtime)

        assert service.capability_description is not None
        assert len(service.capability_description) > 0
        assert "Python Starter Service" in service.capability_description

