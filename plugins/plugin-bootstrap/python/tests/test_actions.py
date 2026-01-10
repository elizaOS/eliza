"""
Tests for Bootstrap Plugin actions.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from elizaos_plugin_bootstrap.actions import (
    ignore_action,
    none_action,
    reply_action,
)
from tests.conftest import MockContent, MockMemory, MockState


class TestReplyAction:
    """Tests for the REPLY action."""

    @pytest.mark.asyncio
    async def test_reply_action_name(self) -> None:
        """Test that REPLY action has correct name."""
        assert reply_action.name == "REPLY"

    @pytest.mark.asyncio
    async def test_reply_action_similes(self) -> None:
        """Test that REPLY action has expected similes."""
        assert "RESPOND" in reply_action.similes
        assert "GREET" in reply_action.similes

    @pytest.mark.asyncio
    async def test_reply_handler_requires_state(
        self,
        mock_runtime: MagicMock,
        mock_message: MockMemory,
    ) -> None:
        """Test that REPLY handler requires state."""
        with pytest.raises(ValueError, match="State is required"):
            await reply_action.handler(
                runtime=mock_runtime,
                message=mock_message,
                state=None,
            )

    @pytest.mark.asyncio
    async def test_reply_handler_success(
        self,
        mock_runtime: MagicMock,
        mock_message: MockMemory,
        mock_state: MockState,
    ) -> None:
        """Test successful REPLY action execution."""
        mock_runtime.use_model.return_value = (
            "<response><thought>Thinking...</thought><text>Hello!</text></response>"
        )

        result = await reply_action.handler(
            runtime=mock_runtime,
            message=mock_message,
            state=mock_state,
        )

        assert result.success is True
        assert result.values["success"] is True
        assert result.values["responded"] is True


class TestIgnoreAction:
    """Tests for the IGNORE action."""

    @pytest.mark.asyncio
    async def test_ignore_action_name(self) -> None:
        """Test that IGNORE action has correct name."""
        assert ignore_action.name == "IGNORE"

    @pytest.mark.asyncio
    async def test_ignore_handler_success(
        self,
        mock_runtime: MagicMock,
        mock_message: MockMemory,
        mock_state: MockState,
    ) -> None:
        """Test successful IGNORE action execution."""
        result = await ignore_action.handler(
            runtime=mock_runtime,
            message=mock_message,
            state=mock_state,
        )

        assert result.success is True
        assert result.values["success"] is True
        assert result.values["ignored"] is True


class TestNoneAction:
    """Tests for the NONE action."""

    @pytest.mark.asyncio
    async def test_none_action_name(self) -> None:
        """Test that NONE action has correct name."""
        assert none_action.name == "NONE"

    @pytest.mark.asyncio
    async def test_none_handler_success(
        self,
        mock_runtime: MagicMock,
        mock_message: MockMemory,
    ) -> None:
        """Test successful NONE action execution."""
        result = await none_action.handler(
            runtime=mock_runtime,
            message=mock_message,
        )

        assert result.success is True
        assert result.values["noAction"] is True

