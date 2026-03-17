"""Tests for iMessage send_message action."""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from elizaos_plugin_imessage.actions.send_message import handler, validate
from elizaos_plugin_imessage.types import IMessageSendResult

# ============================================================
# validate
# ============================================================


class TestValidate:
    @pytest.mark.asyncio
    async def test_returns_true_for_imessage_source(self):
        runtime = MagicMock()
        message = MagicMock()
        message.content = {"source": "imessage"}
        result = await validate(runtime, message)
        assert result is True

    @pytest.mark.asyncio
    async def test_returns_false_for_other_source(self):
        runtime = MagicMock()
        message = MagicMock()
        message.content = {"source": "discord"}
        result = await validate(runtime, message)
        assert result is False

    @pytest.mark.asyncio
    async def test_returns_false_for_no_source(self):
        runtime = MagicMock()
        message = MagicMock()
        message.content = {}
        result = await validate(runtime, message)
        assert result is False

    @pytest.mark.asyncio
    async def test_returns_false_for_empty_source(self):
        runtime = MagicMock()
        message = MagicMock()
        message.content = {"source": ""}
        result = await validate(runtime, message)
        assert result is False


# ============================================================
# handler - service unavailable
# ============================================================


class TestHandlerServiceUnavailable:
    @pytest.mark.asyncio
    async def test_no_service(self):
        runtime = MagicMock()
        runtime.get_service = MagicMock(return_value=None)
        message = MagicMock()
        message.content = {"source": "imessage", "text": "Hello"}
        callback = AsyncMock()

        result = await handler(runtime, message, state=None, callback=callback)

        assert result["success"] is False
        assert "not available" in result["error"]
        callback.assert_called_once()

    @pytest.mark.asyncio
    async def test_service_not_connected(self):
        service = MagicMock()
        service.is_connected = MagicMock(return_value=False)

        runtime = MagicMock()
        runtime.get_service = MagicMock(return_value=service)
        message = MagicMock()
        message.content = {"source": "imessage", "text": "Hello"}
        callback = AsyncMock()

        result = await handler(runtime, message, state=None, callback=callback)

        assert result["success"] is False
        callback.assert_called_once()

    @pytest.mark.asyncio
    async def test_not_macos(self):
        service = MagicMock()
        service.is_connected = MagicMock(return_value=True)
        service.is_macos = MagicMock(return_value=False)

        runtime = MagicMock()
        runtime.get_service = MagicMock(return_value=service)
        message = MagicMock()
        message.content = {"source": "imessage", "text": "Hello"}
        callback = AsyncMock()

        result = await handler(runtime, message, state=None, callback=callback)

        assert result["success"] is False
        assert "macOS" in result["error"]


# ============================================================
# handler - parameter extraction
# ============================================================


class TestHandlerExtraction:
    def _setup_mocks(self):
        service = MagicMock()
        service.is_connected = MagicMock(return_value=True)
        service.is_macos = MagicMock(return_value=True)
        service.send_message = AsyncMock(
            return_value=IMessageSendResult(
                success=True, message_id="12345", chat_id="+15551234567"
            )
        )

        runtime = MagicMock()
        runtime.get_service = MagicMock(return_value=service)

        message = MagicMock()
        message.content = {"source": "imessage", "text": "Send hello"}

        return runtime, message, service

    @pytest.mark.asyncio
    async def test_successful_send_with_llm_extraction(self):
        runtime, message, service = self._setup_mocks()

        # Mock LLM to return valid JSON
        llm_response = json.dumps({"text": "Hello!", "to": "+15551234567"})
        runtime.use_model = AsyncMock(return_value=llm_response)

        state = {"recentMessages": "User: Send hello to +15551234567"}
        callback = AsyncMock()

        result = await handler(runtime, message, state=state, callback=callback)

        assert result["success"] is True
        assert result["data"]["to"] == "+15551234567"
        service.send_message.assert_called_once()

    @pytest.mark.asyncio
    async def test_extraction_failure_after_retries(self):
        runtime, message, service = self._setup_mocks()

        # Mock LLM to return invalid responses
        runtime.use_model = AsyncMock(return_value="I don't understand")

        state = {"recentMessages": "something"}
        callback = AsyncMock()

        result = await handler(runtime, message, state=state, callback=callback)

        assert result["success"] is False
        assert "Could not extract" in result["error"]

    @pytest.mark.asyncio
    async def test_fallback_to_state_chat_id(self):
        runtime, message, service = self._setup_mocks()

        # LLM returns text but "current" target
        llm_response = json.dumps({"text": "Hello!", "to": "current"})
        runtime.use_model = AsyncMock(return_value=llm_response)

        state = {
            "recentMessages": "User: reply with hello",
            "data": {"chatId": "chat_id:existing_chat", "handle": "+15559999999"},
        }
        callback = AsyncMock()

        result = await handler(runtime, message, state=state, callback=callback)

        assert result["success"] is True
        # Should have used the chatId from state
        sent_to = service.send_message.call_args[0][0]
        assert sent_to in ("chat_id:existing_chat", "+15559999999")

    @pytest.mark.asyncio
    async def test_no_target_found(self):
        runtime, message, service = self._setup_mocks()

        # LLM returns text but "current" target, no state data
        llm_response = json.dumps({"text": "Hello!", "to": "current"})
        runtime.use_model = AsyncMock(return_value=llm_response)

        state = {"recentMessages": "something"}
        callback = AsyncMock()

        result = await handler(runtime, message, state=state, callback=callback)

        assert result["success"] is False
        assert "Could not determine" in result["error"]

    @pytest.mark.asyncio
    async def test_send_failure(self):
        runtime, message, service = self._setup_mocks()

        service.send_message = AsyncMock(
            return_value=IMessageSendResult(success=False, error="Network error")
        )

        llm_response = json.dumps({"text": "Hello!", "to": "+15551234567"})
        runtime.use_model = AsyncMock(return_value=llm_response)

        state = {"recentMessages": "Send hello"}
        callback = AsyncMock()

        result = await handler(runtime, message, state=state, callback=callback)

        assert result["success"] is False
        assert result["error"] == "Network error"

    @pytest.mark.asyncio
    async def test_handler_without_callback(self):
        runtime, message, service = self._setup_mocks()

        llm_response = json.dumps({"text": "Hello!", "to": "+15551234567"})
        runtime.use_model = AsyncMock(return_value=llm_response)

        state = {"recentMessages": "Send hello"}

        # No callback - should not raise
        result = await handler(runtime, message, state=state, callback=None)

        assert result["success"] is True

    @pytest.mark.asyncio
    async def test_llm_returns_json_in_code_block(self):
        runtime, message, service = self._setup_mocks()

        # LLM wraps JSON in markdown code block
        llm_response = '```json\n{"text": "Hello!", "to": "+15551234567"}\n```'
        runtime.use_model = AsyncMock(return_value=llm_response)

        state = {"recentMessages": "Send hello"}
        callback = AsyncMock()

        result = await handler(runtime, message, state=state, callback=callback)

        assert result["success"] is True
