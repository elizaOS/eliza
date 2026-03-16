"""Tests for ACP plugin actions."""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from elizaos_plugin_acp.actions import (
    handle_create_checkout_session,
    handle_get_checkout_session,
    validate_create_checkout_session,
    validate_get_checkout_session,
)


class TestCreateCheckoutSessionAction:
    """Tests for create checkout session action."""

    @pytest.mark.asyncio
    async def test_validate_without_env(self, mock_runtime, mock_message) -> None:
        """Test validation fails without environment variable."""
        with patch.dict(os.environ, {}, clear=True):
            result = await validate_create_checkout_session(mock_runtime, mock_message)
            assert result is False

    @pytest.mark.asyncio
    async def test_validate_with_env(self, mock_runtime, mock_message) -> None:
        """Test validation passes with environment variable."""
        with patch.dict(os.environ, {"ACP_MERCHANT_BASE_URL": "https://merchant.example.com"}):
            result = await validate_create_checkout_session(mock_runtime, mock_message)
            assert result is True

    @pytest.mark.asyncio
    async def test_handle_without_room(self, mock_runtime, mock_state) -> None:
        """Test handling fails without room context or client configuration."""
        from tests.conftest import MockMessage

        message = MockMessage(text="Buy items", room_id=None)

        result = await handle_create_checkout_session(mock_runtime, message, mock_state)

        # Should fail - either due to missing room or missing client config
        assert result.success is False
        assert result.error is not None

    @pytest.mark.asyncio
    async def test_handle_without_client(self, mock_runtime, mock_message, mock_state) -> None:
        """Test handling fails without configured client."""
        with patch.dict(os.environ, {}, clear=True):
            result = await handle_create_checkout_session(mock_runtime, mock_message, mock_state)

            assert result.success is False
            assert "not available" in result.text.lower() or "not configured" in result.error.lower()


class TestGetCheckoutSessionAction:
    """Tests for get checkout session action."""

    @pytest.mark.asyncio
    async def test_validate_with_env(self, mock_runtime, mock_message) -> None:
        """Test validation passes with environment variable."""
        with patch.dict(os.environ, {"ACP_MERCHANT_BASE_URL": "https://merchant.example.com"}):
            result = await validate_get_checkout_session(mock_runtime, mock_message)
            assert result is True

    @pytest.mark.asyncio
    async def test_handle_without_session(self, mock_runtime, mock_message, mock_state) -> None:
        """Test handling fails without active session."""
        with patch.dict(os.environ, {"ACP_MERCHANT_BASE_URL": "https://merchant.example.com"}):
            result = await handle_get_checkout_session(mock_runtime, mock_message, mock_state)

            assert result.success is False
            assert "no active" in result.text.lower() or "no active" in result.error.lower()
