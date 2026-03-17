"""Tests for iMessage plugin type definitions and utility functions."""


from elizaos_plugin_imessage.types import (
    DEFAULT_POLL_INTERVAL_MS,
    IMESSAGE_SERVICE_NAME,
    MAX_IMESSAGE_MESSAGE_LENGTH,
    IMessageChat,
    IMessageCliError,
    IMessageConfigurationError,
    IMessageContact,
    IMessageEventTypes,
    IMessageMessage,
    IMessageNotSupportedError,
    IMessagePluginError,
    IMessageSendResult,
    IMessageSettings,
    format_phone_number,
    is_email,
    is_macos,
    is_phone_number,
    is_valid_imessage_target,
    normalize_imessage_target,
    split_message_for_imessage,
)

# ============================================================
# Constants
# ============================================================


class TestConstants:
    def test_max_message_length(self):
        assert MAX_IMESSAGE_MESSAGE_LENGTH == 4000

    def test_default_poll_interval(self):
        assert DEFAULT_POLL_INTERVAL_MS == 5000

    def test_service_name(self):
        assert IMESSAGE_SERVICE_NAME == "imessage"


class TestEventTypes:
    def test_message_received(self):
        assert IMessageEventTypes.MESSAGE_RECEIVED == "IMESSAGE_MESSAGE_RECEIVED"

    def test_message_sent(self):
        assert IMessageEventTypes.MESSAGE_SENT == "IMESSAGE_MESSAGE_SENT"

    def test_connection_ready(self):
        assert IMessageEventTypes.CONNECTION_READY == "IMESSAGE_CONNECTION_READY"

    def test_error(self):
        assert IMessageEventTypes.ERROR == "IMESSAGE_ERROR"


# ============================================================
# Dataclass construction
# ============================================================


class TestIMessageSettings:
    def test_defaults(self):
        settings = IMessageSettings()
        assert settings.cli_path == "imsg"
        assert settings.db_path is None
        assert settings.poll_interval_ms == DEFAULT_POLL_INTERVAL_MS
        assert settings.dm_policy == "pairing"
        assert settings.group_policy == "allowlist"
        assert settings.allow_from == []
        assert settings.enabled is True

    def test_custom_values(self):
        settings = IMessageSettings(
            cli_path="/usr/local/bin/imsg",
            db_path="/tmp/chat.db",
            poll_interval_ms=10000,
            dm_policy="open",
            group_policy="disabled",
            allow_from=["+15551234567"],
            enabled=False,
        )
        assert settings.cli_path == "/usr/local/bin/imsg"
        assert settings.db_path == "/tmp/chat.db"
        assert settings.poll_interval_ms == 10000
        assert settings.dm_policy == "open"
        assert settings.group_policy == "disabled"
        assert settings.allow_from == ["+15551234567"]
        assert settings.enabled is False


class TestIMessageContact:
    def test_minimal(self):
        contact = IMessageContact(handle="+15551234567")
        assert contact.handle == "+15551234567"
        assert contact.display_name is None
        assert contact.is_phone_number is False

    def test_full(self):
        contact = IMessageContact(
            handle="+15551234567",
            display_name="John Doe",
            is_phone_number=True,
        )
        assert contact.display_name == "John Doe"
        assert contact.is_phone_number is True


class TestIMessageChat:
    def test_minimal(self):
        chat = IMessageChat(chat_id="chat1", chat_type="direct")
        assert chat.chat_id == "chat1"
        assert chat.chat_type == "direct"
        assert chat.display_name is None
        assert chat.participants == []

    def test_group(self):
        chat = IMessageChat(
            chat_id="chat2",
            chat_type="group",
            display_name="Work Team",
            participants=[IMessageContact(handle="+15551111111")],
        )
        assert chat.chat_type == "group"
        assert chat.display_name == "Work Team"
        assert len(chat.participants) == 1


class TestIMessageMessage:
    def test_minimal(self):
        msg = IMessageMessage(
            id="msg1",
            text="Hello",
            handle="+15551234567",
            chat_id="chat1",
            timestamp=1700000000000,
        )
        assert msg.id == "msg1"
        assert msg.text == "Hello"
        assert msg.handle == "+15551234567"
        assert msg.chat_id == "chat1"
        assert msg.timestamp == 1700000000000
        assert msg.is_from_me is False
        assert msg.has_attachments is False
        assert msg.attachment_paths == []

    def test_from_me_with_attachments(self):
        msg = IMessageMessage(
            id="msg2",
            text="Check this out",
            handle="me",
            chat_id="chat1",
            timestamp=1700000000000,
            is_from_me=True,
            has_attachments=True,
            attachment_paths=["/tmp/photo.jpg"],
        )
        assert msg.is_from_me is True
        assert msg.has_attachments is True
        assert msg.attachment_paths == ["/tmp/photo.jpg"]


class TestIMessageSendResult:
    def test_success(self):
        result = IMessageSendResult(
            success=True, message_id="12345", chat_id="chat1"
        )
        assert result.success is True
        assert result.message_id == "12345"
        assert result.chat_id == "chat1"
        assert result.error is None

    def test_failure(self):
        result = IMessageSendResult(success=False, error="Send failed")
        assert result.success is False
        assert result.message_id is None
        assert result.error == "Send failed"


# ============================================================
# is_phone_number
# ============================================================


class TestIsPhoneNumber:
    def test_valid_us_phone(self):
        assert is_phone_number("+15551234567") is True

    def test_valid_us_without_plus(self):
        assert is_phone_number("15551234567") is True

    def test_formatted_phone(self):
        assert is_phone_number("1-555-123-4567") is True
        assert is_phone_number("(555) 123-4567") is True
        assert is_phone_number("555.123.4567") is True

    def test_international_phone(self):
        assert is_phone_number("+44 7700 900000") is True
        assert is_phone_number("+61412345678") is True

    def test_rejects_email(self):
        assert is_phone_number("test@example.com") is False

    def test_rejects_too_short(self):
        assert is_phone_number("12345") is False
        assert is_phone_number("123") is False

    def test_rejects_text(self):
        assert is_phone_number("hello world") is False
        assert is_phone_number("not a phone") is False

    def test_rejects_empty(self):
        assert is_phone_number("") is False


# ============================================================
# is_email
# ============================================================


class TestIsEmail:
    def test_valid_email(self):
        assert is_email("test@example.com") is True

    def test_valid_subdomain(self):
        assert is_email("user.name@domain.co.uk") is True

    def test_valid_complex(self):
        assert is_email("admin@sub.domain.org") is True

    def test_rejects_phone(self):
        assert is_email("+15551234567") is False

    def test_rejects_text(self):
        assert is_email("not an email") is False
        assert is_email("hello") is False

    def test_rejects_partial(self):
        assert is_email("@domain.com") is False
        assert is_email("user@") is False

    def test_rejects_empty(self):
        assert is_email("") is False


# ============================================================
# is_valid_imessage_target
# ============================================================


class TestIsValidIMessageTarget:
    def test_phone_number(self):
        assert is_valid_imessage_target("+15551234567") is True

    def test_email(self):
        assert is_valid_imessage_target("user@example.com") is True

    def test_chat_id_prefix(self):
        assert is_valid_imessage_target("chat_id:iMessage;+;12345") is True

    def test_invalid(self):
        assert is_valid_imessage_target("hello world") is False
        assert is_valid_imessage_target("123") is False

    def test_whitespace_handling(self):
        assert is_valid_imessage_target("  +15551234567  ") is True


# ============================================================
# normalize_imessage_target
# ============================================================


class TestNormalizeIMessageTarget:
    def test_empty_returns_none(self):
        assert normalize_imessage_target("") is None
        assert normalize_imessage_target("   ") is None

    def test_chat_id_prefix_preserved(self):
        assert normalize_imessage_target("chat_id:12345") == "chat_id:12345"

    def test_imessage_prefix_stripped(self):
        result = normalize_imessage_target("imessage:+15551234567")
        assert result == "+15551234567"

    def test_case_insensitive_imessage_prefix(self):
        result = normalize_imessage_target("iMessage:user@test.com")
        assert result == "user@test.com"

    def test_trims_whitespace(self):
        assert normalize_imessage_target("  +15551234567  ") == "+15551234567"

    def test_phone_passthrough(self):
        assert normalize_imessage_target("+15551234567") == "+15551234567"

    def test_email_passthrough(self):
        assert normalize_imessage_target("user@example.com") == "user@example.com"


# ============================================================
# format_phone_number
# ============================================================


class TestFormatPhoneNumber:
    def test_removes_formatting(self):
        assert format_phone_number("+1 (555) 123-4567") == "+15551234567"

    def test_adds_plus_for_international(self):
        assert format_phone_number("15551234567") == "+15551234567"

    def test_preserves_existing_plus(self):
        assert format_phone_number("+15551234567") == "+15551234567"

    def test_ten_digit_no_plus(self):
        assert format_phone_number("5551234567") == "5551234567"

    def test_removes_dots_and_spaces(self):
        assert format_phone_number("555.123.4567") == "5551234567"


# ============================================================
# split_message_for_imessage
# ============================================================


class TestSplitMessageForIMessage:
    def test_short_message_single_chunk(self):
        result = split_message_for_imessage("Hello world")
        assert result == ["Hello world"]

    def test_exact_max_length(self):
        text = "a" * MAX_IMESSAGE_MESSAGE_LENGTH
        result = split_message_for_imessage(text)
        assert len(result) == 1
        assert result[0] == text

    def test_splits_long_at_word_boundaries(self):
        words = " ".join(f"word{i}" for i in range(500))
        result = split_message_for_imessage(words, max_length=100)
        assert len(result) > 1
        for chunk in result:
            assert len(chunk) <= 100

    def test_prefers_newline_break(self):
        text = "a" * 60 + "\n" + "b" * 30
        result = split_message_for_imessage(text, max_length=80)
        assert len(result) == 2
        assert result[0] == "a" * 60
        assert result[1] == "b" * 30

    def test_no_break_points(self):
        text = "a" * 200
        result = split_message_for_imessage(text, max_length=100)
        assert len(result) > 1
        # All content preserved
        assert "".join(result) == text

    def test_empty_string(self):
        result = split_message_for_imessage("")
        assert result == [""]


# ============================================================
# is_macos
# ============================================================


class TestIsMacos:
    def test_returns_bool(self):
        result = is_macos()
        assert isinstance(result, bool)


# ============================================================
# Error classes
# ============================================================


class TestErrors:
    def test_plugin_error(self):
        err = IMessagePluginError("test error", "TEST_CODE", {"key": "value"})
        assert str(err) == "test error"
        assert err.code == "TEST_CODE"
        assert err.details == {"key": "value"}
        assert isinstance(err, Exception)

    def test_configuration_error(self):
        err = IMessageConfigurationError("bad config", "cli_path")
        assert str(err) == "bad config"
        assert err.code == "CONFIGURATION_ERROR"
        assert err.details == {"setting": "cli_path"}
        assert isinstance(err, IMessagePluginError)

    def test_configuration_error_no_setting(self):
        err = IMessageConfigurationError("bad config")
        assert err.details is None or err.details == {}

    def test_not_supported_error_default(self):
        err = IMessageNotSupportedError()
        assert "macOS" in str(err)
        assert err.code == "NOT_SUPPORTED"
        assert isinstance(err, IMessagePluginError)

    def test_not_supported_error_custom(self):
        err = IMessageNotSupportedError("custom msg")
        assert str(err) == "custom msg"

    def test_cli_error(self):
        err = IMessageCliError("command failed", 1)
        assert str(err) == "command failed"
        assert err.code == "CLI_ERROR"
        assert err.details == {"exit_code": 1}
        assert isinstance(err, IMessagePluginError)

    def test_cli_error_no_exit_code(self):
        err = IMessageCliError("command failed")
        assert err.details is None or err.details == {}
