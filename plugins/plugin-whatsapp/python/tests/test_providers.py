"""Tests for WhatsApp plugin providers."""

import pytest

from elizaos_plugin_whatsapp.providers.chat_state import _format_chat_state
from elizaos_plugin_whatsapp.types import WhatsAppChatState


class TestFormatChatState:
    """Tests for _format_chat_state helper (no elizaos dependency needed)."""

    def test_basic_format(self) -> None:
        state = WhatsAppChatState(
            phone_number_id="phone-123",
            contact_wa_id="15551234567",
        )
        result = _format_chat_state(state)
        assert "# WhatsApp Chat Context" in result
        assert "15551234567" in result
        assert "WhatsApp" in result

    def test_includes_contact_name(self) -> None:
        state = WhatsAppChatState(
            phone_number_id="phone-123",
            contact_wa_id="15551234567",
            contact_name="Alice",
        )
        result = _format_chat_state(state)
        assert "Alice" in result
        assert "Name:" in result

    def test_includes_last_message_timestamp(self) -> None:
        state = WhatsAppChatState(
            phone_number_id="phone-123",
            contact_wa_id="15551234567",
            last_message_at=1700000000,
        )
        result = _format_chat_state(state)
        assert "Last Message:" in result

    def test_includes_helpfulness_note(self) -> None:
        state = WhatsAppChatState(
            phone_number_id="phone-123",
            contact_wa_id="15551234567",
        )
        result = _format_chat_state(state)
        assert "helpful and concise" in result

    def test_full_state(self) -> None:
        state = WhatsAppChatState(
            phone_number_id="phone-123",
            contact_wa_id="15559999999",
            contact_name="Bob",
            last_message_at=1700000000,
        )
        result = _format_chat_state(state)
        lines = result.split("\n")
        assert lines[0] == "# WhatsApp Chat Context"
        assert any("Contact:" in line for line in lines)
        assert any("Name:" in line for line in lines)
        assert any("Last Message:" in line for line in lines)


class TestChatStateProviderMetadata:
    """Tests for chat_state_provider metadata (requires elizaos for Provider type)."""

    def test_provider_import(self) -> None:
        pytest.importorskip("elizaos", reason="elizaos not installed")
        from elizaos_plugin_whatsapp.providers.chat_state import chat_state_provider

        assert chat_state_provider.name == "WHATSAPP_CHAT_STATE"
        assert "WhatsApp" in chat_state_provider.description
        assert chat_state_provider.get is not None
