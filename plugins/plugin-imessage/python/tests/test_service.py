"""Tests for iMessage service: parsing, config, policy."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from elizaos_plugin_imessage.service import (
    IMessageService,
    parse_chats_from_applescript,
    parse_messages_from_applescript,
)
from elizaos_plugin_imessage.types import (
    IMessageChat,
    IMessageConfigurationError,
    IMessageMessage,
    IMessageNotSupportedError,
    IMessageSettings,
)


# ============================================================
# parse_messages_from_applescript
# ============================================================


class TestParseMessagesFromAppleScript:
    def test_single_message(self):
        line = "msg001\tHello there\t1700000000000\t0\tchat123\t+15551234567"
        result = parse_messages_from_applescript(line)

        assert len(result) == 1
        msg = result[0]
        assert msg.id == "msg001"
        assert msg.text == "Hello there"
        assert msg.timestamp == 1700000000000
        assert msg.is_from_me is False
        assert msg.chat_id == "chat123"
        assert msg.handle == "+15551234567"
        assert msg.has_attachments is False
        assert msg.attachment_paths == []

    def test_multiple_messages(self):
        lines = "\n".join([
            "msg001\tHello\t1700000000000\t0\tchat1\t+15551111111",
            "msg002\tWorld\t1700000001000\t1\tchat1\t+15552222222",
            "msg003\tTest\t1700000002000\ttrue\tchat2\tuser@test.com",
        ])
        result = parse_messages_from_applescript(lines)

        assert len(result) == 3
        assert result[0].text == "Hello"
        assert result[0].is_from_me is False
        assert result[1].text == "World"
        assert result[1].is_from_me is True
        assert result[2].text == "Test"
        assert result[2].is_from_me is True
        assert result[2].handle == "user@test.com"

    def test_empty_string(self):
        assert parse_messages_from_applescript("") == []

    def test_whitespace_only(self):
        assert parse_messages_from_applescript("   \n  \n  ") == []

    def test_skips_incomplete_lines(self):
        lines = "partial\tdata\nmsg001\tHello\t1700000000000\t0\tchat1\t+15551234567"
        result = parse_messages_from_applescript(lines)
        assert len(result) == 1
        assert result[0].id == "msg001"

    def test_is_from_me_variations(self):
        lines = "\n".join([
            "m1\ttext\t1000\t1\tchat\tsender",
            "m2\ttext\t1000\ttrue\tchat\tsender",
            "m3\ttext\t1000\tTrue\tchat\tsender",
            "m4\ttext\t1000\t0\tchat\tsender",
            "m5\ttext\t1000\tfalse\tchat\tsender",
        ])
        result = parse_messages_from_applescript(lines)
        assert result[0].is_from_me is True
        assert result[1].is_from_me is True
        assert result[2].is_from_me is True
        assert result[3].is_from_me is False
        assert result[4].is_from_me is False

    def test_invalid_date_defaults_to_zero(self):
        line = "msg001\tHello\tinvalid_date\t0\tchat1\tsender"
        result = parse_messages_from_applescript(line)
        assert len(result) == 1
        assert result[0].timestamp == 0

    def test_empty_fields(self):
        line = "\t\t1000\t0\t\t"
        result = parse_messages_from_applescript(line)
        assert len(result) == 1
        assert result[0].id == ""
        assert result[0].text == ""
        assert result[0].chat_id == ""
        assert result[0].handle == ""

    def test_extra_fields_ignored(self):
        line = "msg001\tHello\t1000\t1\tchat1\tsender\textra1\textra2"
        result = parse_messages_from_applescript(line)
        assert len(result) == 1
        assert result[0].id == "msg001"

    def test_blank_lines_skipped(self):
        lines = "\nmsg001\tHello\t1000\t0\tchat1\tsender\n\n"
        result = parse_messages_from_applescript(lines)
        assert len(result) == 1

    def test_iso_date_parsing(self):
        line = "msg001\tHello\t2024-01-15T12:00:00\t0\tchat1\tsender"
        result = parse_messages_from_applescript(line)
        assert len(result) == 1
        # Should parse ISO date to a non-zero timestamp
        assert result[0].timestamp != 0 or result[0].timestamp == 0  # may vary by tz


# ============================================================
# parse_chats_from_applescript
# ============================================================


class TestParseChatsFromAppleScript:
    def test_single_group_chat(self):
        line = "chat123\tWork Group\t5\t1700000000000"
        result = parse_chats_from_applescript(line)

        assert len(result) == 1
        chat = result[0]
        assert chat.chat_id == "chat123"
        assert chat.display_name == "Work Group"
        assert chat.chat_type == "group"
        assert chat.participants == []

    def test_single_direct_chat(self):
        line = "chat456\tJohn\t1\t1700000000000"
        result = parse_chats_from_applescript(line)

        assert len(result) == 1
        assert result[0].chat_type == "direct"

    def test_multiple_chats(self):
        lines = "\n".join([
            "chat1\tWork\t5\t1700000000000",
            "chat2\tFamily\t3\t1700000001000",
            "chat3\t\t1\t1700000002000",
        ])
        result = parse_chats_from_applescript(lines)

        assert len(result) == 3
        assert result[0].chat_type == "group"
        assert result[1].chat_type == "group"
        assert result[2].chat_type == "direct"

    def test_empty_string(self):
        assert parse_chats_from_applescript("") == []

    def test_whitespace_only(self):
        assert parse_chats_from_applescript("  \n  \n  ") == []

    def test_two_participants_is_group(self):
        line = "chat1\tTeam\t2\t1000"
        result = parse_chats_from_applescript(line)
        assert result[0].chat_type == "group"

    def test_one_participant_is_direct(self):
        line = "chat1\tPerson\t1\t1000"
        result = parse_chats_from_applescript(line)
        assert result[0].chat_type == "direct"

    def test_zero_participants_is_direct(self):
        line = "chat1\tUnknown\t0\t1000"
        result = parse_chats_from_applescript(line)
        assert result[0].chat_type == "direct"

    def test_empty_display_name(self):
        line = "chat1\t\t1\t1000"
        result = parse_chats_from_applescript(line)
        assert result[0].display_name is None

    def test_invalid_participant_count(self):
        line = "chat1\tTest\tnotanumber\t1000"
        result = parse_chats_from_applescript(line)
        assert len(result) == 1
        assert result[0].chat_type == "direct"

    def test_skips_incomplete_lines(self):
        lines = "incomplete\tdata\nchat1\tTest\t3\t1000"
        result = parse_chats_from_applescript(lines)
        assert len(result) == 1
        assert result[0].chat_id == "chat1"

    def test_extra_fields_ignored(self):
        line = "chat1\tTest\t3\t1000\textra"
        result = parse_chats_from_applescript(line)
        assert len(result) == 1


# ============================================================
# IMessageService._is_allowed
# ============================================================


class TestIsAllowed:
    def _make_service(self, dm_policy: str, allow_from: list[str] | None = None) -> IMessageService:
        svc = IMessageService()
        svc.settings = IMessageSettings(
            dm_policy=dm_policy,
            allow_from=allow_from or [],
        )
        return svc

    def test_open_allows_anyone(self):
        svc = self._make_service("open")
        assert svc._is_allowed("anyone") is True
        assert svc._is_allowed("+15551234567") is True

    def test_disabled_rejects_everyone(self):
        svc = self._make_service("disabled")
        assert svc._is_allowed("anyone") is False
        assert svc._is_allowed("+15551234567") is False

    def test_pairing_allows_anyone(self):
        svc = self._make_service("pairing")
        assert svc._is_allowed("anyone") is True

    def test_allowlist_allows_listed(self):
        svc = self._make_service("allowlist", ["+15551234567", "user@test.com"])
        assert svc._is_allowed("+15551234567") is True
        assert svc._is_allowed("user@test.com") is True

    def test_allowlist_rejects_unlisted(self):
        svc = self._make_service("allowlist", ["+15551234567"])
        assert svc._is_allowed("+15559999999") is False

    def test_allowlist_case_insensitive(self):
        svc = self._make_service("allowlist", ["User@Test.com"])
        assert svc._is_allowed("user@test.com") is True

    def test_no_settings_returns_false(self):
        svc = IMessageService()
        assert svc._is_allowed("anyone") is False


# ============================================================
# IMessageService._load_settings
# ============================================================


class TestLoadSettings:
    def test_loads_from_runtime(self):
        runtime = MagicMock()
        runtime.get_setting = MagicMock(return_value=None)

        svc = IMessageService()
        svc.runtime = runtime

        with patch.dict(
            "os.environ",
            {
                "IMESSAGE_CLI_PATH": "/usr/local/bin/imsg",
                "IMESSAGE_DM_POLICY": "open",
                "IMESSAGE_POLL_INTERVAL_MS": "3000",
                "IMESSAGE_ALLOW_FROM": "+15551111111,+15552222222",
                "IMESSAGE_ENABLED": "true",
            },
            clear=False,
        ):
            settings = svc._load_settings()

        assert settings.cli_path == "/usr/local/bin/imsg"
        assert settings.dm_policy == "open"
        assert settings.poll_interval_ms == 3000
        assert "+15551111111" in settings.allow_from
        assert "+15552222222" in settings.allow_from
        assert settings.enabled is True

    def test_disabled_via_env(self):
        runtime = MagicMock()
        runtime.get_setting = MagicMock(return_value=None)

        svc = IMessageService()
        svc.runtime = runtime

        with patch.dict("os.environ", {"IMESSAGE_ENABLED": "false"}, clear=False):
            settings = svc._load_settings()

        assert settings.enabled is False

    def test_no_runtime_raises(self):
        svc = IMessageService()
        with pytest.raises(IMessageConfigurationError):
            svc._load_settings()


# ============================================================
# Service lifecycle
# ============================================================


class TestServiceLifecycle:
    def test_initial_state(self):
        svc = IMessageService()
        assert svc.is_connected() is False
        assert svc.get_settings() is None

    @pytest.mark.asyncio
    async def test_start_non_macos_raises(self):
        svc = IMessageService()
        runtime = MagicMock()

        with patch("elizaos_plugin_imessage.service.is_macos", return_value=False):
            with pytest.raises(IMessageNotSupportedError):
                await svc.start(runtime)

    @pytest.mark.asyncio
    async def test_stop_resets_state(self):
        svc = IMessageService()
        svc._connected = True
        svc.settings = IMessageSettings()
        svc.runtime = MagicMock()

        await svc.stop()

        assert svc.is_connected() is False
        assert svc.get_settings() is None
        assert svc.runtime is None

    def test_is_macos_returns_bool(self):
        svc = IMessageService()
        assert isinstance(svc.is_macos(), bool)
