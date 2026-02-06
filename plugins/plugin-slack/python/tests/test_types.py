"""
Tests for Slack plugin type definitions and validation utilities.
"""

import pytest
from dataclasses import fields

from elizaos_plugin_slack.types import (
    SlackEventTypes,
    SlackChannel,
    SlackChannelPurpose,
    SlackChannelTopic,
    SlackFile,
    SlackMessage,
    SlackReaction,
    SlackSettings,
    SlackUser,
    SlackUserProfile,
    SlackPluginError,
    SlackServiceNotInitializedError,
    SlackClientNotAvailableError,
    SlackConfigurationError,
    SlackApiError,
    is_valid_channel_id,
    is_valid_user_id,
    is_valid_team_id,
    is_valid_message_ts,
    get_slack_user_display_name,
    get_slack_channel_type,
    MAX_SLACK_MESSAGE_LENGTH,
    MAX_SLACK_BLOCKS,
    MAX_SLACK_FILE_SIZE,
    SLACK_SERVICE_NAME,
)

from conftest import make_user, make_user_profile, make_channel


# ===================================================================
# Constants
# ===================================================================

class TestConstants:
    def test_service_name(self):
        assert SLACK_SERVICE_NAME == "slack"

    def test_max_message_length(self):
        assert MAX_SLACK_MESSAGE_LENGTH == 4000

    def test_max_blocks(self):
        assert MAX_SLACK_BLOCKS == 50

    def test_max_file_size(self):
        assert MAX_SLACK_FILE_SIZE == 1024 * 1024 * 1024  # 1 GB


# ===================================================================
# SlackEventTypes enum
# ===================================================================

class TestSlackEventTypes:
    def test_all_event_types_defined(self):
        expected = [
            "MESSAGE_RECEIVED", "MESSAGE_SENT", "REACTION_ADDED", "REACTION_REMOVED",
            "CHANNEL_JOINED", "CHANNEL_LEFT", "MEMBER_JOINED_CHANNEL", "MEMBER_LEFT_CHANNEL",
            "APP_MENTION", "SLASH_COMMAND", "FILE_SHARED", "THREAD_REPLY",
        ]
        for name in expected:
            assert hasattr(SlackEventTypes, name)

    def test_event_values_prefixed(self):
        for member in SlackEventTypes:
            assert member.value.startswith("SLACK_")

    def test_message_received_value(self):
        assert SlackEventTypes.MESSAGE_RECEIVED.value == "SLACK_MESSAGE_RECEIVED"

    def test_event_is_string_enum(self):
        assert isinstance(SlackEventTypes.APP_MENTION, str)
        assert SlackEventTypes.APP_MENTION == "SLACK_APP_MENTION"

    def test_enum_count(self):
        assert len(SlackEventTypes) == 12


# ===================================================================
# Validation functions
# ===================================================================

class TestIsValidChannelId:
    @pytest.mark.parametrize("valid_id", [
        "C0123456789",
        "G0123456789",
        "D0123456789",
        "C012345678901234",
        "c0123456789",  # case-insensitive
    ])
    def test_valid_channel_ids(self, valid_id):
        assert is_valid_channel_id(valid_id) is True

    @pytest.mark.parametrize("invalid_id", [
        "",
        "invalid",
        "C123",       # too short
        "U0123456789", # wrong prefix
        "T0123456789", # wrong prefix
        "123456789",   # no prefix
        "C",
        "C0123 456",  # space
    ])
    def test_invalid_channel_ids(self, invalid_id):
        assert is_valid_channel_id(invalid_id) is False


class TestIsValidUserId:
    @pytest.mark.parametrize("valid_id", [
        "U0123456789",
        "W0123456789",
        "U012345678901234",
        "u0123456789",  # case-insensitive
    ])
    def test_valid_user_ids(self, valid_id):
        assert is_valid_user_id(valid_id) is True

    @pytest.mark.parametrize("invalid_id", [
        "",
        "invalid",
        "U123",        # too short
        "C0123456789", # wrong prefix
        "T0123456789", # wrong prefix
        "B0123456789", # wrong prefix
    ])
    def test_invalid_user_ids(self, invalid_id):
        assert is_valid_user_id(invalid_id) is False


class TestIsValidTeamId:
    @pytest.mark.parametrize("valid_id", [
        "T0123456789",
        "T012345678901234",
        "t0123456789",
    ])
    def test_valid_team_ids(self, valid_id):
        assert is_valid_team_id(valid_id) is True

    @pytest.mark.parametrize("invalid_id", [
        "",
        "invalid",
        "T123",        # too short
        "C0123456789", # wrong prefix
        "U0123456789", # wrong prefix
    ])
    def test_invalid_team_ids(self, invalid_id):
        assert is_valid_team_id(invalid_id) is False


class TestIsValidMessageTs:
    @pytest.mark.parametrize("valid_ts", [
        "1234567890.123456",
        "1700000000.000001",
        "9999999999.999999",
    ])
    def test_valid_timestamps(self, valid_ts):
        assert is_valid_message_ts(valid_ts) is True

    @pytest.mark.parametrize("invalid_ts", [
        "",
        "invalid",
        "1234567890",          # no decimal
        "1234567890.12345",    # 5 decimal digits
        "1234567890.1234567",  # 7 decimal digits
        "abc.123456",
        ".123456",
        "1234567890.",
    ])
    def test_invalid_timestamps(self, invalid_ts):
        assert is_valid_message_ts(invalid_ts) is False


# ===================================================================
# get_slack_user_display_name
# ===================================================================

class TestGetSlackUserDisplayName:
    def test_prefers_display_name(self):
        user = make_user(
            profile=make_user_profile(display_name="Display", real_name="Real"),
            name="username",
        )
        assert get_slack_user_display_name(user) == "Display"

    def test_falls_back_to_real_name(self):
        user = make_user(
            profile=make_user_profile(display_name=None, real_name="Real Name"),
            name="username",
        )
        assert get_slack_user_display_name(user) == "Real Name"

    def test_falls_back_to_name(self):
        user = make_user(
            profile=make_user_profile(display_name=None, real_name=None),
            name="username",
        )
        assert get_slack_user_display_name(user) == "username"

    def test_empty_display_name_falls_through(self):
        user = make_user(
            profile=make_user_profile(display_name="", real_name="Real"),
            name="username",
        )
        # Empty string is falsy, should fall to real_name
        result = get_slack_user_display_name(user)
        assert result == "Real"

    def test_all_none_falls_to_name(self):
        user = make_user(
            profile=make_user_profile(display_name=None, real_name=None),
            name="fallback",
        )
        assert get_slack_user_display_name(user) == "fallback"


# ===================================================================
# get_slack_channel_type
# ===================================================================

class TestGetSlackChannelType:
    def test_im_channel(self):
        ch = make_channel(is_im=True, is_channel=False)
        assert get_slack_channel_type(ch) == "im"

    def test_mpim_channel(self):
        ch = make_channel(is_mpim=True, is_channel=False)
        assert get_slack_channel_type(ch) == "mpim"

    def test_group_channel(self):
        ch = make_channel(is_group=True, is_private=False, is_channel=False)
        assert get_slack_channel_type(ch) == "group"

    def test_private_channel(self):
        ch = make_channel(is_private=True, is_group=False, is_channel=False)
        assert get_slack_channel_type(ch) == "group"

    def test_public_channel(self):
        ch = make_channel(is_im=False, is_mpim=False, is_group=False, is_private=False)
        assert get_slack_channel_type(ch) == "channel"

    def test_im_takes_precedence_over_group(self):
        ch = make_channel(is_im=True, is_group=True, is_channel=False)
        assert get_slack_channel_type(ch) == "im"

    def test_mpim_takes_precedence_over_group(self):
        ch = make_channel(is_mpim=True, is_group=True, is_im=False, is_channel=False)
        assert get_slack_channel_type(ch) == "mpim"


# ===================================================================
# Dataclass construction
# ===================================================================

class TestDataclassConstruction:
    def test_slack_user_profile_defaults(self):
        p = SlackUserProfile()
        assert p.title is None
        assert p.display_name is None

    def test_slack_user_required_fields(self):
        u = SlackUser(
            id="U001",
            name="test",
            profile=SlackUserProfile(),
        )
        assert u.id == "U001"
        assert u.is_bot is False
        assert u.deleted is False

    def test_slack_channel_required_fields(self):
        ch = SlackChannel(id="C001", name="test", created=0, creator="U001")
        assert ch.is_archived is False
        assert ch.num_members is None

    def test_slack_file_required_fields(self):
        f = SlackFile(
            id="F001", name="file.txt", title="File", mimetype="text/plain",
            filetype="txt", size=100, url_private="https://files/1",
        )
        assert f.id == "F001"
        assert f.url_private_download is None

    def test_slack_reaction(self):
        r = SlackReaction(name="thumbsup", count=3, users=["U1", "U2", "U3"])
        assert r.count == 3
        assert len(r.users) == 3

    def test_slack_reaction_default_users(self):
        r = SlackReaction(name="heart", count=1)
        assert r.users == []

    def test_slack_message_minimal(self):
        m = SlackMessage(type="message", ts="1234567890.123456", text="Hello")
        assert m.user is None
        assert m.thread_ts is None
        assert m.reactions is None

    def test_slack_settings_defaults(self):
        s = SlackSettings()
        assert s.allowed_channel_ids is None
        assert s.should_ignore_bot_messages is False
        assert s.should_respond_only_to_mentions is False

    def test_slack_channel_topic(self):
        t = SlackChannelTopic(value="Topic", creator="U001", last_set=1000)
        assert t.value == "Topic"

    def test_slack_channel_purpose(self):
        p = SlackChannelPurpose(value="Purpose", creator="U001", last_set=2000)
        assert p.value == "Purpose"


# ===================================================================
# Error classes
# ===================================================================

class TestErrorClasses:
    def test_base_error(self):
        err = SlackPluginError("test error", "TEST_CODE")
        assert str(err) == "test error"
        assert err.code == "TEST_CODE"
        assert isinstance(err, Exception)

    def test_service_not_initialized(self):
        err = SlackServiceNotInitializedError()
        assert "not initialized" in str(err).lower()
        assert err.code == "SERVICE_NOT_INITIALIZED"
        assert isinstance(err, SlackPluginError)

    def test_client_not_available(self):
        err = SlackClientNotAvailableError()
        assert "not available" in str(err).lower()
        assert err.code == "CLIENT_NOT_AVAILABLE"
        assert isinstance(err, SlackPluginError)

    def test_configuration_error(self):
        err = SlackConfigurationError("SLACK_BOT_TOKEN")
        assert "SLACK_BOT_TOKEN" in str(err)
        assert err.code == "MISSING_CONFIG"
        assert isinstance(err, SlackPluginError)

    def test_api_error(self):
        err = SlackApiError("rate limited", api_error_code="ratelimited")
        assert "rate limited" in str(err)
        assert err.code == "API_ERROR"
        assert err.api_error_code == "ratelimited"
        assert isinstance(err, SlackPluginError)

    def test_api_error_no_code(self):
        err = SlackApiError("unknown error")
        assert err.api_error_code is None

    def test_error_inheritance_chain(self):
        err = SlackServiceNotInitializedError()
        assert isinstance(err, SlackPluginError)
        assert isinstance(err, Exception)

    def test_errors_are_raisable(self):
        with pytest.raises(SlackServiceNotInitializedError):
            raise SlackServiceNotInitializedError()
        with pytest.raises(SlackClientNotAvailableError):
            raise SlackClientNotAvailableError()
        with pytest.raises(SlackConfigurationError):
            raise SlackConfigurationError("TOKEN")
        with pytest.raises(SlackApiError):
            raise SlackApiError("boom")
