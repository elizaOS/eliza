"""Tests for Tlon plugin configuration and error types."""

from __future__ import annotations

import os
from unittest import mock

import pytest
from pydantic import ValidationError

from elizaos_plugin_tlon.config import (
    TlonConfig,
    build_channel_nest,
    format_ship,
    normalize_ship,
    parse_channel_nest,
)
from elizaos_plugin_tlon.error import (
    AuthenticationError,
    ClientNotInitializedError,
    ConfigError,
    ConnectionError,
    MessageSendError,
    PokeError,
    ScryError,
    SubscribeError,
    TlonError,
)


# ---------------------------------------------------------------------------
# normalize_ship / format_ship
# ---------------------------------------------------------------------------
class TestNormalizeShip:
    """Tests for the normalize_ship helper."""

    def test_strips_tilde(self) -> None:
        assert normalize_ship("~sampel-palnet") == "sampel-palnet"

    def test_no_op_without_tilde(self) -> None:
        assert normalize_ship("sampel-palnet") == "sampel-palnet"

    def test_strips_multiple_leading_tildes(self) -> None:
        # lstrip("~") strips all leading ~
        assert normalize_ship("~~double") == "double"

    def test_empty_string(self) -> None:
        assert normalize_ship("") == ""


class TestFormatShip:
    """Tests for the format_ship helper."""

    def test_adds_tilde(self) -> None:
        assert format_ship("sampel-palnet") == "~sampel-palnet"

    def test_does_not_double_tilde(self) -> None:
        assert format_ship("~sampel-palnet") == "~sampel-palnet"

    def test_empty_string_gets_tilde(self) -> None:
        assert format_ship("") == "~"


# ---------------------------------------------------------------------------
# parse_channel_nest / build_channel_nest
# ---------------------------------------------------------------------------
class TestParseChannelNest:
    """Tests for parse_channel_nest."""

    def test_valid_nest(self) -> None:
        result = parse_channel_nest("chat/~host-ship/channel-name")
        assert result is not None
        kind, host, name = result
        assert kind == "chat"
        assert host == "host-ship"
        assert name == "channel-name"

    def test_normalizes_host_ship(self) -> None:
        result = parse_channel_nest("diary/~my-ship/notes")
        assert result is not None
        assert result[1] == "my-ship"

    def test_returns_none_for_too_few_parts(self) -> None:
        assert parse_channel_nest("single") is None
        assert parse_channel_nest("only/two") is None

    def test_returns_none_for_too_many_parts(self) -> None:
        assert parse_channel_nest("a/b/c/d") is None

    def test_returns_none_for_empty_parts(self) -> None:
        assert parse_channel_nest("//") is None
        assert parse_channel_nest("/host/name") is None


class TestBuildChannelNest:
    """Tests for build_channel_nest."""

    def test_builds_correct_string(self) -> None:
        assert build_channel_nest("chat", "host-ship", "general") == "chat/~host-ship/general"

    def test_does_not_double_tilde(self) -> None:
        assert build_channel_nest("chat", "~host-ship", "general") == "chat/~host-ship/general"


# ---------------------------------------------------------------------------
# TlonConfig
# ---------------------------------------------------------------------------
class TestTlonConfig:
    """Tests for the TlonConfig pydantic model."""

    def test_creation_with_required_fields(self) -> None:
        config = TlonConfig(
            ship="~sampel-palnet",
            url="https://sampel-palnet.tlon.network/",
            code="lidlut-tabwed",
        )
        assert config.ship == "sampel-palnet"  # normalized
        assert config.url == "https://sampel-palnet.tlon.network"  # trailing slash stripped
        assert config.code == "lidlut-tabwed"

    def test_defaults(self) -> None:
        config = TlonConfig(
            ship="ship",
            url="https://example.com",
            code="code",
        )
        assert config.enabled is True
        assert config.group_channels == []
        assert config.dm_allowlist == []
        assert config.auto_discover_channels is True

    def test_ship_normalization_strips_tilde(self) -> None:
        config = TlonConfig(ship="~my-ship", url="https://x.com", code="c")
        assert config.ship == "my-ship"

    def test_url_trailing_slash_stripped(self) -> None:
        config = TlonConfig(ship="s", url="https://x.com///", code="c")
        assert not config.url.endswith("/")

    def test_dm_allowlist_normalized(self) -> None:
        config = TlonConfig(
            ship="s",
            url="https://x.com",
            code="c",
            dm_allowlist=["~ship-a", "ship-b"],
        )
        assert config.dm_allowlist == ["ship-a", "ship-b"]

    def test_formatted_ship(self) -> None:
        config = TlonConfig(ship="sampel-palnet", url="https://x.com", code="c")
        assert config.formatted_ship() == "~sampel-palnet"


class TestTlonConfigDmAllowed:
    """Tests for TlonConfig.is_dm_allowed."""

    def test_empty_allowlist_allows_all(self) -> None:
        config = TlonConfig(ship="s", url="https://x.com", code="c")
        assert config.is_dm_allowed("any-ship") is True

    def test_allowlist_permits_listed_ship(self) -> None:
        config = TlonConfig(
            ship="s",
            url="https://x.com",
            code="c",
            dm_allowlist=["allowed-ship"],
        )
        assert config.is_dm_allowed("allowed-ship") is True

    def test_allowlist_blocks_unlisted_ship(self) -> None:
        config = TlonConfig(
            ship="s",
            url="https://x.com",
            code="c",
            dm_allowlist=["allowed-ship"],
        )
        assert config.is_dm_allowed("random-ship") is False

    def test_normalizes_ship_before_check(self) -> None:
        config = TlonConfig(
            ship="s",
            url="https://x.com",
            code="c",
            dm_allowlist=["allowed-ship"],
        )
        assert config.is_dm_allowed("~allowed-ship") is True


class TestTlonConfigFromEnv:
    """Tests for TlonConfig.from_env."""

    def test_loads_required_vars(self) -> None:
        env = {
            "TLON_SHIP": "~sampel-palnet",
            "TLON_URL": "https://example.com",
            "TLON_CODE": "secret-code",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            config = TlonConfig.from_env()
        assert config.ship == "sampel-palnet"
        assert config.url == "https://example.com"
        assert config.code == "secret-code"
        assert config.enabled is True

    def test_raises_for_missing_ship(self) -> None:
        env = {
            "TLON_URL": "https://example.com",
            "TLON_CODE": "code",
        }
        with mock.patch.dict(os.environ, env, clear=True), pytest.raises(ValueError, match="TLON_SHIP"):
            TlonConfig.from_env()

    def test_raises_for_missing_url(self) -> None:
        env = {
            "TLON_SHIP": "ship",
            "TLON_CODE": "code",
        }
        with mock.patch.dict(os.environ, env, clear=True), pytest.raises(ValueError, match="TLON_URL"):
            TlonConfig.from_env()

    def test_raises_for_missing_code(self) -> None:
        env = {
            "TLON_SHIP": "ship",
            "TLON_URL": "https://example.com",
        }
        with mock.patch.dict(os.environ, env, clear=True), pytest.raises(ValueError, match="TLON_CODE"):
            TlonConfig.from_env()

    def test_parses_optional_enabled_false(self) -> None:
        env = {
            "TLON_SHIP": "ship",
            "TLON_URL": "https://example.com",
            "TLON_CODE": "code",
            "TLON_ENABLED": "false",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            config = TlonConfig.from_env()
        assert config.enabled is False

    def test_parses_group_channels_json(self) -> None:
        env = {
            "TLON_SHIP": "ship",
            "TLON_URL": "https://example.com",
            "TLON_CODE": "code",
            "TLON_GROUP_CHANNELS": '["chat/~host/general","chat/~host/random"]',
        }
        with mock.patch.dict(os.environ, env, clear=False):
            config = TlonConfig.from_env()
        assert config.group_channels == ["chat/~host/general", "chat/~host/random"]

    def test_invalid_json_for_channels_yields_empty(self) -> None:
        env = {
            "TLON_SHIP": "ship",
            "TLON_URL": "https://example.com",
            "TLON_CODE": "code",
            "TLON_GROUP_CHANNELS": "not-json",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            config = TlonConfig.from_env()
        assert config.group_channels == []

    def test_auto_discover_false(self) -> None:
        env = {
            "TLON_SHIP": "ship",
            "TLON_URL": "https://example.com",
            "TLON_CODE": "code",
            "TLON_AUTO_DISCOVER_CHANNELS": "false",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            config = TlonConfig.from_env()
        assert config.auto_discover_channels is False


# ---------------------------------------------------------------------------
# Error types
# ---------------------------------------------------------------------------
class TestErrorHierarchy:
    """Tests for the Tlon error class hierarchy."""

    def test_tlon_error_is_exception(self) -> None:
        assert issubclass(TlonError, Exception)

    def test_config_error_is_tlon_error(self) -> None:
        err = ConfigError("bad config")
        assert isinstance(err, TlonError)
        assert isinstance(err, Exception)
        assert str(err) == "bad config"

    def test_authentication_error_is_tlon_error(self) -> None:
        err = AuthenticationError("auth failed")
        assert isinstance(err, TlonError)
        assert str(err) == "auth failed"

    def test_connection_error_is_tlon_error(self) -> None:
        err = ConnectionError("conn failed")
        assert isinstance(err, TlonError)
        assert str(err) == "conn failed"

    def test_subscribe_error_is_tlon_error(self) -> None:
        err = SubscribeError("sub failed")
        assert isinstance(err, TlonError)

    def test_poke_error_is_tlon_error(self) -> None:
        err = PokeError("poke failed")
        assert isinstance(err, TlonError)

    def test_scry_error_is_tlon_error(self) -> None:
        err = ScryError("scry failed")
        assert isinstance(err, TlonError)


class TestClientNotInitializedError:
    """Tests for the ClientNotInitializedError."""

    def test_default_message(self) -> None:
        err = ClientNotInitializedError()
        assert str(err) == "Tlon client is not initialized"

    def test_is_tlon_error(self) -> None:
        err = ClientNotInitializedError()
        assert isinstance(err, TlonError)


class TestMessageSendError:
    """Tests for the MessageSendError."""

    def test_message_includes_target(self) -> None:
        err = MessageSendError("sampel-palnet")
        assert "sampel-palnet" in str(err)
        assert err.target == "sampel-palnet"
        assert err.cause is None

    def test_message_includes_cause(self) -> None:
        cause = RuntimeError("network timeout")
        err = MessageSendError("chat/~host/ch", cause)
        assert "chat/~host/ch" in str(err)
        assert "network timeout" in str(err)
        assert err.cause is cause
        assert err.target == "chat/~host/ch"

    def test_is_tlon_error(self) -> None:
        err = MessageSendError("target")
        assert isinstance(err, TlonError)

    def test_can_be_raised_and_caught(self) -> None:
        with pytest.raises(TlonError):
            raise MessageSendError("target", RuntimeError("boom"))
