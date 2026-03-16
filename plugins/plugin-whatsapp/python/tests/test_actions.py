"""Tests for WhatsApp plugin actions."""

import pytest

pytest.importorskip("elizaos", reason="elizaos not installed")

from elizaos_plugin_whatsapp.actions.send_message import (
    WHATSAPP_SERVICE_NAME,
    handler,
    send_message_action,
    validate,
)


class TestSendMessageActionMetadata:
    """Tests for send_message_action metadata."""

    def test_name(self) -> None:
        assert send_message_action.name == "SEND_WHATSAPP_MESSAGE"

    def test_description(self) -> None:
        assert "WhatsApp" in send_message_action.description

    def test_similes(self) -> None:
        assert "WHATSAPP_SEND" in send_message_action.similes
        assert "TEXT_WHATSAPP" in send_message_action.similes
        assert "MESSAGE_WHATSAPP" in send_message_action.similes

    def test_examples_present(self) -> None:
        assert send_message_action.examples is not None
        assert len(send_message_action.examples) > 0

    def test_has_validate(self) -> None:
        assert send_message_action.validate is validate

    def test_has_handler(self) -> None:
        assert send_message_action.handler is handler


class TestSendMessageValidate:
    """Tests for send_message validate function."""

    @pytest.mark.asyncio
    async def test_returns_false_when_no_service(self) -> None:
        class MockRuntime:
            def get_service(self, name: str):
                return None

        class MockMessage:
            pass

        result = await validate(MockRuntime(), MockMessage())
        assert result is False

    @pytest.mark.asyncio
    async def test_returns_false_when_service_not_running(self) -> None:
        class MockService:
            is_running = False

        class MockRuntime:
            def get_service(self, name: str):
                return MockService()

        class MockMessage:
            pass

        result = await validate(MockRuntime(), MockMessage())
        assert result is False

    @pytest.mark.asyncio
    async def test_returns_true_when_service_is_running(self) -> None:
        class MockService:
            is_running = True

        class MockRuntime:
            def get_service(self, name: str):
                return MockService()

        class MockMessage:
            pass

        result = await validate(MockRuntime(), MockMessage())
        assert result is True

    @pytest.mark.asyncio
    async def test_validate_checks_whatsapp_service(self) -> None:
        called_with = []

        class MockRuntime:
            def get_service(self, name: str):
                called_with.append(name)
                return None

        class MockMessage:
            pass

        await validate(MockRuntime(), MockMessage())
        assert WHATSAPP_SERVICE_NAME in called_with


class TestSendMessageHandler:
    """Tests for send_message handler error paths."""

    @pytest.mark.asyncio
    async def test_handler_returns_none_when_no_service(self) -> None:
        from elizaos.types import Content, Memory

        class MockRuntime:
            def get_service(self, name: str):
                return None

        callback_called = []

        def mock_callback(content):
            callback_called.append(content)

        message = Memory(
            room_id="room-1",
            entity_id="entity-1",
            content=Content(text="Hello"),
        )

        result = await handler(MockRuntime(), message, callback=mock_callback)
        assert result is None
        assert len(callback_called) == 1
        assert "unavailable" in callback_called[0].text.lower()

    @pytest.mark.asyncio
    async def test_handler_returns_none_when_service_not_running(self) -> None:
        from elizaos.types import Content, Memory

        class MockService:
            is_running = False

        class MockRuntime:
            def get_service(self, name: str):
                return MockService()

        message = Memory(
            room_id="room-1",
            entity_id="entity-1",
            content=Content(text="Hello"),
        )

        result = await handler(MockRuntime(), message)
        assert result is None
