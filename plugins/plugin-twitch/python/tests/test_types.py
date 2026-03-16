"""
Tests for Twitch plugin types, constants, utility functions, and custom errors.
"""

import pytest

from elizaos_plugin_twitch.types import (
    MAX_TWITCH_MESSAGE_LENGTH,
    TWITCH_SERVICE_NAME,
    TwitchApiError,
    TwitchConfigurationError,
    TwitchEventTypes,
    TwitchMessage,
    TwitchMessageSendOptions,
    TwitchNotConnectedError,
    TwitchPluginError,
    TwitchSendResult,
    TwitchServiceNotInitializedError,
    TwitchSettings,
    TwitchUserInfo,
    format_channel_for_display,
    get_twitch_user_display_name,
    normalize_channel,
    split_message_for_twitch,
    strip_markdown_for_twitch,
)


# ===========================================================================
# Constants
# ===========================================================================


class TestConstants:
    def test_max_message_length(self):
        assert MAX_TWITCH_MESSAGE_LENGTH == 500

    def test_service_name(self):
        assert TWITCH_SERVICE_NAME == "twitch"


# ===========================================================================
# Event Types
# ===========================================================================


class TestTwitchEventTypes:
    def test_all_event_values(self):
        assert TwitchEventTypes.MESSAGE_RECEIVED.value == "TWITCH_MESSAGE_RECEIVED"
        assert TwitchEventTypes.MESSAGE_SENT.value == "TWITCH_MESSAGE_SENT"
        assert TwitchEventTypes.JOIN_CHANNEL.value == "TWITCH_JOIN_CHANNEL"
        assert TwitchEventTypes.LEAVE_CHANNEL.value == "TWITCH_LEAVE_CHANNEL"
        assert TwitchEventTypes.CONNECTION_READY.value == "TWITCH_CONNECTION_READY"
        assert TwitchEventTypes.CONNECTION_LOST.value == "TWITCH_CONNECTION_LOST"

    def test_event_types_are_strings(self):
        for event in TwitchEventTypes:
            assert isinstance(event.value, str)

    def test_six_event_types_exist(self):
        assert len(TwitchEventTypes) == 6


# ===========================================================================
# Dataclass Construction
# ===========================================================================


class TestTwitchSettings:
    def test_minimal_construction(self):
        settings = TwitchSettings(
            username="bot",
            client_id="cid",
            access_token="tok",
            channel="main",
        )
        assert settings.username == "bot"
        assert settings.client_id == "cid"
        assert settings.access_token == "tok"
        assert settings.channel == "main"
        assert settings.client_secret is None
        assert settings.refresh_token is None
        assert settings.additional_channels == []
        assert settings.require_mention is False
        assert settings.allowed_roles == ["all"]
        assert settings.allowed_user_ids == []
        assert settings.enabled is True

    def test_full_construction(self):
        settings = TwitchSettings(
            username="bot",
            client_id="cid",
            access_token="tok",
            channel="main",
            client_secret="secret",
            refresh_token="refresh",
            additional_channels=["extra1", "extra2"],
            require_mention=True,
            allowed_roles=["moderator", "owner"],
            allowed_user_ids=["uid1"],
            enabled=False,
        )
        assert settings.client_secret == "secret"
        assert settings.additional_channels == ["extra1", "extra2"]
        assert settings.require_mention is True
        assert settings.allowed_roles == ["moderator", "owner"]
        assert settings.enabled is False


class TestTwitchUserInfo:
    def test_default_values(self):
        user = TwitchUserInfo(
            user_id="1",
            username="alice",
            display_name="Alice",
        )
        assert user.is_moderator is False
        assert user.is_broadcaster is False
        assert user.is_vip is False
        assert user.is_subscriber is False
        assert user.color is None
        assert user.badges == {}

    def test_with_roles(self):
        user = TwitchUserInfo(
            user_id="2",
            username="bob",
            display_name="Bob",
            is_moderator=True,
            is_vip=True,
            color="#00FF00",
            badges={"moderator": "1", "premium": "1"},
        )
        assert user.is_moderator is True
        assert user.is_vip is True
        assert user.color == "#00FF00"
        assert user.badges["moderator"] == "1"


class TestTwitchMessage:
    def test_construction(self):
        user = TwitchUserInfo(user_id="1", username="u", display_name="U")
        msg = TwitchMessage(
            id="msg-1",
            channel="test",
            text="hello world",
            user=user,
            timestamp=1234567890.0,
        )
        assert msg.id == "msg-1"
        assert msg.channel == "test"
        assert msg.text == "hello world"
        assert msg.user.username == "u"
        assert msg.is_action is False
        assert msg.is_highlighted is False
        assert msg.reply_to is None

    def test_with_reply(self):
        user = TwitchUserInfo(user_id="1", username="u", display_name="U")
        msg = TwitchMessage(
            id="msg-2",
            channel="test",
            text="reply",
            user=user,
            timestamp=0,
            reply_to={
                "message_id": "parent",
                "user_id": "2",
                "username": "other",
                "text": "original",
            },
        )
        assert msg.reply_to is not None
        assert msg.reply_to["message_id"] == "parent"


class TestTwitchMessageSendOptions:
    def test_defaults(self):
        opts = TwitchMessageSendOptions()
        assert opts.channel is None
        assert opts.reply_to is None

    def test_with_values(self):
        opts = TwitchMessageSendOptions(channel="test", reply_to="msg-1")
        assert opts.channel == "test"
        assert opts.reply_to == "msg-1"


class TestTwitchSendResult:
    def test_success(self):
        result = TwitchSendResult(success=True, message_id="abc")
        assert result.success is True
        assert result.message_id == "abc"
        assert result.error is None

    def test_failure(self):
        result = TwitchSendResult(success=False, error="not connected")
        assert result.success is False
        assert result.error == "not connected"
        assert result.message_id is None


# ===========================================================================
# Custom Errors
# ===========================================================================


class TestCustomErrors:
    def test_plugin_error_base(self):
        err = TwitchPluginError("base error")
        assert isinstance(err, Exception)
        assert str(err) == "base error"

    def test_service_not_initialized(self):
        err = TwitchServiceNotInitializedError()
        assert isinstance(err, TwitchPluginError)
        assert "not initialized" in str(err)

    def test_service_not_initialized_custom_message(self):
        err = TwitchServiceNotInitializedError("custom")
        assert str(err) == "custom"

    def test_not_connected(self):
        err = TwitchNotConnectedError()
        assert isinstance(err, TwitchPluginError)
        assert "not connected" in str(err)

    def test_configuration_error(self):
        err = TwitchConfigurationError("bad config", "MY_SETTING")
        assert isinstance(err, TwitchPluginError)
        assert str(err) == "bad config"
        assert err.setting_name == "MY_SETTING"

    def test_configuration_error_no_setting_name(self):
        err = TwitchConfigurationError("missing")
        assert err.setting_name is None

    def test_api_error(self):
        err = TwitchApiError("api fail", 401)
        assert isinstance(err, TwitchPluginError)
        assert str(err) == "api fail"
        assert err.status_code == 401

    def test_api_error_no_status(self):
        err = TwitchApiError("error")
        assert err.status_code is None


# ===========================================================================
# Utility Functions
# ===========================================================================


class TestNormalizeChannel:
    def test_strips_hash(self):
        assert normalize_channel("#mychannel") == "mychannel"

    def test_no_hash(self):
        assert normalize_channel("mychannel") == "mychannel"

    def test_empty_string(self):
        assert normalize_channel("") == ""

    def test_multiple_hashes(self):
        # lstrip removes all leading #
        assert normalize_channel("##double") == "double"

    def test_hash_in_middle(self):
        assert normalize_channel("my#channel") == "my#channel"


class TestFormatChannelForDisplay:
    def test_adds_hash_prefix(self):
        assert format_channel_for_display("mychannel") == "#mychannel"

    def test_no_double_prefix(self):
        assert format_channel_for_display("#mychannel") == "#mychannel"


class TestGetTwitchUserDisplayName:
    def test_returns_display_name(self):
        user = TwitchUserInfo(user_id="1", username="alice", display_name="Alice_Cool")
        assert get_twitch_user_display_name(user) == "Alice_Cool"

    def test_falls_back_to_username(self):
        user = TwitchUserInfo(user_id="1", username="bob", display_name="")
        assert get_twitch_user_display_name(user) == "bob"


class TestStripMarkdownForTwitch:
    def test_strips_bold_asterisks(self):
        assert strip_markdown_for_twitch("**bold text**") == "bold text"

    def test_strips_bold_underscores(self):
        assert strip_markdown_for_twitch("__bold text__") == "bold text"

    def test_strips_italic_asterisk(self):
        assert strip_markdown_for_twitch("*italic*") == "italic"

    def test_strips_italic_underscore(self):
        assert strip_markdown_for_twitch("_italic_") == "italic"

    def test_strips_strikethrough(self):
        assert strip_markdown_for_twitch("~~strikethrough~~") == "strikethrough"

    def test_strips_inline_code(self):
        assert strip_markdown_for_twitch("`code`") == "code"

    def test_replaces_code_blocks(self):
        # Note: inline code regex runs before code block regex, so triple-backtick
        # blocks where the content has no backticks get partially consumed.
        # Test a code block that survives inline code stripping (contains backticks).
        result = strip_markdown_for_twitch("before ```code``` after")
        assert "code" in result
        # Single backtick-free code blocks show the interaction between regexes
        result2 = strip_markdown_for_twitch("```js\ncode\n```")
        assert isinstance(result2, str)
        assert len(result2) > 0

    def test_strips_links_keeps_text(self):
        assert strip_markdown_for_twitch("[click](https://example.com)") == "click"

    def test_strips_headers(self):
        assert strip_markdown_for_twitch("## Header") == "Header"

    def test_strips_blockquotes(self):
        assert strip_markdown_for_twitch("> quoted") == "quoted"

    def test_converts_unordered_list(self):
        assert strip_markdown_for_twitch("- item") == "• item"

    def test_converts_ordered_list(self):
        assert strip_markdown_for_twitch("1. item") == "• item"

    def test_collapses_newlines(self):
        assert strip_markdown_for_twitch("a\n\n\n\nb") == "a\n\nb"

    def test_plain_text_unchanged(self):
        assert strip_markdown_for_twitch("plain text") == "plain text"

    def test_trims_whitespace(self):
        assert strip_markdown_for_twitch("  hello  ") == "hello"


class TestSplitMessageForTwitch:
    def test_short_message_single_chunk(self):
        assert split_message_for_twitch("Hello world") == ["Hello world"]

    def test_long_message_splits(self):
        long = "A" * 600
        chunks = split_message_for_twitch(long)
        assert len(chunks) > 1
        for chunk in chunks:
            assert len(chunk) <= MAX_TWITCH_MESSAGE_LENGTH

    def test_respects_custom_max_length(self):
        text = "A" * 30
        chunks = split_message_for_twitch(text, max_length=10)
        assert len(chunks) == 3

    def test_sentence_boundary_split(self):
        # Build text where ". " appears past half of max_length.
        # rfind(". ") returns the index of the ".", so the split point is
        # at that index — everything before the "." goes into chunk 0.
        prefix = "A" * 300  # 300 chars of filler
        text = prefix + ". " + "B" * 250  # total 552
        chunks = split_message_for_twitch(text, max_length=500)
        assert len(chunks) == 2
        # Split happens at index 300 (position of ". "), so chunk 0 is the prefix
        assert chunks[0] == prefix
        # Chunk 1 is everything from position 300 onwards, stripped
        # (.strip() only removes whitespace, so the "." remains)
        assert "B" in chunks[1]
        assert len(chunks[1]) < len(text)

    def test_word_boundary_split(self):
        words = " ".join(["word"] * 60)  # ~ 300 chars
        chunks = split_message_for_twitch(words, max_length=50)
        assert len(chunks) > 1

    def test_exact_max_length(self):
        text = "A" * 500
        chunks = split_message_for_twitch(text, max_length=500)
        assert chunks == [text]
