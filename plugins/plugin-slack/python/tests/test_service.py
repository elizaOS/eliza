"""
Tests for SlackService initialization, configuration, and helper methods.

These tests focus on the synchronous logic that can be tested without
establishing a real Slack connection: settings loading, channel allowlists,
message splitting, cache management, and accessor methods.
"""

import pytest
from types import SimpleNamespace
from unittest.mock import MagicMock, AsyncMock, patch

from elizaos_plugin_slack.service import SlackService
from elizaos_plugin_slack.types import (
    SLACK_SERVICE_NAME,
    MAX_SLACK_MESSAGE_LENGTH,
    SlackSettings,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_runtime(**setting_overrides):
    """Build a minimal mock runtime for SlackService.__init__."""
    defaults = {
        "SLACK_BOT_TOKEN": "xoxb-test",
        "SLACK_APP_TOKEN": "xapp-test",
        "SLACK_SIGNING_SECRET": "secret",
        "SLACK_USER_TOKEN": None,
        "SLACK_CHANNEL_IDS": "",
        "SLACK_SHOULD_IGNORE_BOT_MESSAGES": "false",
        "SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS": "false",
    }
    defaults.update(setting_overrides)

    rt = MagicMock()
    rt.character = SimpleNamespace(settings={})
    rt.get_setting = MagicMock(side_effect=lambda k: defaults.get(k))
    return rt


# ===================================================================
# Class-level attributes
# ===================================================================

class TestServiceClassAttributes:
    def test_service_type(self):
        assert SlackService.service_type == SLACK_SERVICE_NAME

    def test_capability_description(self):
        assert isinstance(SlackService.capability_description, str)
        assert "slack" in SlackService.capability_description.lower()


# ===================================================================
# __init__ – settings loading
# ===================================================================

class TestServiceInit:
    def test_basic_init(self):
        rt = _make_runtime()
        svc = SlackService(rt)
        assert svc.runtime is rt
        assert svc.app is None
        assert svc.client is None
        assert svc.bot_user_id is None
        assert svc.team_id is None

    def test_loads_settings_ignore_bots_false(self):
        rt = _make_runtime(SLACK_SHOULD_IGNORE_BOT_MESSAGES="false")
        svc = SlackService(rt)
        assert svc.settings.should_ignore_bot_messages is False

    def test_loads_settings_ignore_bots_true(self):
        rt = _make_runtime(SLACK_SHOULD_IGNORE_BOT_MESSAGES="true")
        svc = SlackService(rt)
        assert svc.settings.should_ignore_bot_messages is True

    def test_loads_settings_ignore_bots_True_string(self):
        rt = _make_runtime(SLACK_SHOULD_IGNORE_BOT_MESSAGES="True")
        svc = SlackService(rt)
        assert svc.settings.should_ignore_bot_messages is True

    def test_loads_settings_respond_mentions_only(self):
        rt = _make_runtime(SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS="true")
        svc = SlackService(rt)
        assert svc.settings.should_respond_only_to_mentions is True

    def test_default_settings(self):
        rt = _make_runtime()
        svc = SlackService(rt)
        assert isinstance(svc.settings, SlackSettings)
        assert svc.settings.should_ignore_bot_messages is False
        assert svc.settings.should_respond_only_to_mentions is False


# ===================================================================
# Channel allow-list parsing
# ===================================================================

class TestChannelAllowList:
    def test_empty_channel_ids(self):
        rt = _make_runtime(SLACK_CHANNEL_IDS="")
        svc = SlackService(rt)
        assert len(svc._allowed_channel_ids) == 0

    def test_none_channel_ids(self):
        rt = _make_runtime(SLACK_CHANNEL_IDS=None)
        svc = SlackService(rt)
        assert len(svc._allowed_channel_ids) == 0

    def test_single_valid_channel(self):
        rt = _make_runtime(SLACK_CHANNEL_IDS="C0123456789")
        svc = SlackService(rt)
        assert "C0123456789" in svc._allowed_channel_ids

    def test_multiple_valid_channels(self):
        rt = _make_runtime(SLACK_CHANNEL_IDS="C0123456789,G9876543210")
        svc = SlackService(rt)
        assert "C0123456789" in svc._allowed_channel_ids
        assert "G9876543210" in svc._allowed_channel_ids

    def test_trims_whitespace(self):
        rt = _make_runtime(SLACK_CHANNEL_IDS="  C0123456789 , G9876543210  ")
        svc = SlackService(rt)
        assert "C0123456789" in svc._allowed_channel_ids
        assert "G9876543210" in svc._allowed_channel_ids

    def test_skips_invalid_ids(self):
        rt = _make_runtime(SLACK_CHANNEL_IDS="C0123456789,INVALID,G9876543210")
        svc = SlackService(rt)
        assert "C0123456789" in svc._allowed_channel_ids
        assert "INVALID" not in svc._allowed_channel_ids
        assert "G9876543210" in svc._allowed_channel_ids

    def test_whitespace_only(self):
        rt = _make_runtime(SLACK_CHANNEL_IDS="   ")
        svc = SlackService(rt)
        assert len(svc._allowed_channel_ids) == 0


# ===================================================================
# _is_channel_allowed
# ===================================================================

class TestIsChannelAllowed:
    def test_all_allowed_when_no_restrictions(self):
        rt = _make_runtime(SLACK_CHANNEL_IDS="")
        svc = SlackService(rt)
        assert svc._is_channel_allowed("C_ANYTHING") is True

    def test_allowed_channel_passes(self):
        rt = _make_runtime(SLACK_CHANNEL_IDS="C0123456789")
        svc = SlackService(rt)
        assert svc._is_channel_allowed("C0123456789") is True

    def test_disallowed_channel_blocked(self):
        rt = _make_runtime(SLACK_CHANNEL_IDS="C0123456789")
        svc = SlackService(rt)
        assert svc._is_channel_allowed("C_OTHER_CHAN") is False

    def test_dynamic_channel_allowed(self):
        rt = _make_runtime(SLACK_CHANNEL_IDS="C0123456789")
        svc = SlackService(rt)
        svc._dynamic_channel_ids.add("C_DYNAMIC001")
        assert svc._is_channel_allowed("C_DYNAMIC001") is True


# ===================================================================
# Dynamic channel management
# ===================================================================

class TestDynamicChannelManagement:
    def test_add_valid_channel(self):
        rt = _make_runtime()
        svc = SlackService(rt)
        svc.add_allowed_channel("C0123456789")
        assert "C0123456789" in svc._dynamic_channel_ids

    def test_add_invalid_channel_ignored(self):
        rt = _make_runtime()
        svc = SlackService(rt)
        svc.add_allowed_channel("INVALID")
        assert "INVALID" not in svc._dynamic_channel_ids

    def test_remove_channel(self):
        rt = _make_runtime()
        svc = SlackService(rt)
        svc._dynamic_channel_ids.add("C0123456789")
        svc.remove_allowed_channel("C0123456789")
        assert "C0123456789" not in svc._dynamic_channel_ids

    def test_remove_nonexistent_no_error(self):
        rt = _make_runtime()
        svc = SlackService(rt)
        svc.remove_allowed_channel("C0123456789")  # should not raise

    def test_get_allowed_channel_ids_union(self):
        rt = _make_runtime(SLACK_CHANNEL_IDS="C0123456789")
        svc = SlackService(rt)
        svc._dynamic_channel_ids.add("G9876543210")
        ids = svc.get_allowed_channel_ids()
        assert "C0123456789" in ids
        assert "G9876543210" in ids


# ===================================================================
# _split_message
# ===================================================================

class TestSplitMessage:
    def _make_service(self):
        rt = _make_runtime()
        return SlackService(rt)

    def test_short_message_returns_single(self):
        svc = self._make_service()
        result = svc._split_message("Hello")
        assert result == ["Hello"]

    def test_exact_max_length(self):
        svc = self._make_service()
        text = "a" * MAX_SLACK_MESSAGE_LENGTH
        result = svc._split_message(text)
        assert len(result) == 1
        assert result[0] == text

    def test_over_max_length_splits(self):
        svc = self._make_service()
        text = "a" * (MAX_SLACK_MESSAGE_LENGTH + 100)
        result = svc._split_message(text)
        assert len(result) == 2
        assert "".join(result) == text

    def test_splits_at_newline(self):
        svc = self._make_service()
        line = "x" * (MAX_SLACK_MESSAGE_LENGTH // 2)
        text = f"{line}\n{line}\n{'y' * MAX_SLACK_MESSAGE_LENGTH}"
        result = svc._split_message(text)
        assert len(result) >= 2

    def test_splits_at_space(self):
        svc = self._make_service()
        word = "x" * (MAX_SLACK_MESSAGE_LENGTH - 10)
        text = f"{word} {'y' * 100}"
        result = svc._split_message(text)
        assert len(result) >= 1

    def test_empty_message(self):
        svc = self._make_service()
        result = svc._split_message("")
        assert result == [""]

    def test_very_long_message_multiple_splits(self):
        svc = self._make_service()
        text = "word " * 5000  # well over max
        result = svc._split_message(text)
        assert len(result) >= 3
        for chunk in result:
            assert len(chunk) <= MAX_SLACK_MESSAGE_LENGTH


# ===================================================================
# Cache management
# ===================================================================

class TestCacheManagement:
    def test_clear_user_cache(self):
        rt = _make_runtime()
        svc = SlackService(rt)
        svc._user_cache["U001"] = "cached_user"
        svc.clear_user_cache()
        assert len(svc._user_cache) == 0

    def test_clear_channel_cache(self):
        rt = _make_runtime()
        svc = SlackService(rt)
        svc._channel_cache["C001"] = "cached_channel"
        svc.clear_channel_cache()
        assert len(svc._channel_cache) == 0


# ===================================================================
# Accessor methods
# ===================================================================

class TestAccessors:
    def test_is_service_connected_false_by_default(self):
        rt = _make_runtime()
        svc = SlackService(rt)
        assert svc.is_service_connected() is False

    def test_get_bot_user_id_none_by_default(self):
        rt = _make_runtime()
        svc = SlackService(rt)
        assert svc.get_bot_user_id() is None

    def test_get_team_id_none_by_default(self):
        rt = _make_runtime()
        svc = SlackService(rt)
        assert svc.get_team_id() is None

    def test_is_service_connected_requires_both(self):
        rt = _make_runtime()
        svc = SlackService(rt)
        svc._is_connected = True
        # app is still None
        assert svc.is_service_connected() is False

    def test_is_service_connected_true(self):
        rt = _make_runtime()
        svc = SlackService(rt)
        svc._is_connected = True
        svc.app = MagicMock()
        assert svc.is_service_connected() is True


# ===================================================================
# start() class method – missing tokens
# ===================================================================

class TestServiceStart:
    @pytest.mark.asyncio
    async def test_start_without_bot_token_returns_service(self):
        rt = _make_runtime(SLACK_BOT_TOKEN="")
        svc = await SlackService.start(rt)
        assert isinstance(svc, SlackService)
        assert svc.client is None

    @pytest.mark.asyncio
    async def test_start_without_app_token_returns_service(self):
        rt = _make_runtime(SLACK_APP_TOKEN="")
        svc = await SlackService.start(rt)
        assert isinstance(svc, SlackService)
        assert svc.client is None

    @pytest.mark.asyncio
    async def test_start_with_none_bot_token_returns_service(self):
        rt = _make_runtime(SLACK_BOT_TOKEN=None)
        svc = await SlackService.start(rt)
        assert isinstance(svc, SlackService)
        assert svc.client is None

    @pytest.mark.asyncio
    async def test_start_with_whitespace_bot_token_returns_service(self):
        rt = _make_runtime(SLACK_BOT_TOKEN="   ")
        svc = await SlackService.start(rt)
        assert isinstance(svc, SlackService)
        assert svc.client is None
