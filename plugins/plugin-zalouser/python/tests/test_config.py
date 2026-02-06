"""Tests for plugin-zalouser config module."""

import pytest

from elizaos_plugin_zalouser.config import (
    DEFAULT_PROFILE,
    DEFAULT_TIMEOUT_MS,
    MAX_MESSAGE_LENGTH,
    ZaloUserConfig,
    _parse_allowed_threads,
)


class TestZaloUserConfigCreation:
    """Test ZaloUserConfig construction and defaults."""

    def test_default_enabled(self) -> None:
        config = ZaloUserConfig()
        assert config.enabled is True

    def test_default_profile(self) -> None:
        config = ZaloUserConfig()
        assert config.default_profile == DEFAULT_PROFILE

    def test_default_listen_timeout(self) -> None:
        config = ZaloUserConfig()
        assert config.listen_timeout == DEFAULT_TIMEOUT_MS

    def test_default_dm_policy(self) -> None:
        config = ZaloUserConfig()
        assert config.dm_policy == "pairing"

    def test_default_group_policy(self) -> None:
        config = ZaloUserConfig()
        assert config.group_policy == "disabled"

    def test_default_allowed_threads_empty(self) -> None:
        config = ZaloUserConfig()
        assert config.allowed_threads == []

    def test_optional_fields_none(self) -> None:
        config = ZaloUserConfig()
        assert config.cookie_path is None
        assert config.imei is None
        assert config.user_agent is None

    def test_custom_settings(self) -> None:
        config = ZaloUserConfig(
            cookie_path="/tmp/cookie",
            imei="test-imei",
            dm_policy="open",
            group_policy="open",
        )
        assert config.cookie_path == "/tmp/cookie"
        assert config.imei == "test-imei"
        assert config.dm_policy == "open"
        assert config.group_policy == "open"


class TestConstants:
    def test_default_profile(self) -> None:
        assert DEFAULT_PROFILE == "default"

    def test_default_timeout(self) -> None:
        assert DEFAULT_TIMEOUT_MS == 30000

    def test_max_message_length(self) -> None:
        assert MAX_MESSAGE_LENGTH == 2000


class TestIsThreadAllowed:
    def test_empty_list_allows_all(self) -> None:
        config = ZaloUserConfig()
        assert config.is_thread_allowed("any") is True

    def test_allowed_thread(self) -> None:
        config = ZaloUserConfig(allowed_threads=["t1", "t2"])
        assert config.is_thread_allowed("t1") is True

    def test_disallowed_thread(self) -> None:
        config = ZaloUserConfig(allowed_threads=["t1", "t2"])
        assert config.is_thread_allowed("t3") is False


class TestValidateConfig:
    def test_valid_default(self) -> None:
        config = ZaloUserConfig()
        config.validate_config()  # Should not raise

    def test_disabled_raises(self) -> None:
        config = ZaloUserConfig(enabled=False)
        with pytest.raises(ValueError, match="disabled"):
            config.validate_config()


class TestParseAllowedThreads:
    def test_none_returns_empty(self) -> None:
        assert _parse_allowed_threads(None) == []

    def test_empty_string_returns_empty(self) -> None:
        assert _parse_allowed_threads("") == []

    def test_whitespace_returns_empty(self) -> None:
        assert _parse_allowed_threads("   ") == []

    def test_json_array(self) -> None:
        assert _parse_allowed_threads('["a", "b", "c"]') == ["a", "b", "c"]

    def test_comma_separated(self) -> None:
        assert _parse_allowed_threads("a, b, c") == ["a", "b", "c"]

    def test_filters_empty_entries(self) -> None:
        assert _parse_allowed_threads("a,,b,,") == ["a", "b"]

    def test_invalid_json_falls_through(self) -> None:
        result = _parse_allowed_threads("[invalid json")
        assert isinstance(result, list)


class TestFromEnv:
    def test_defaults(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for key in [
            "ZALOUSER_COOKIE_PATH", "ZALOUSER_IMEI", "ZALOUSER_USER_AGENT",
            "ZALOUSER_ENABLED", "ZALOUSER_DEFAULT_PROFILE", "ZALOUSER_LISTEN_TIMEOUT",
            "ZALOUSER_ALLOWED_THREADS", "ZALOUSER_DM_POLICY", "ZALOUSER_GROUP_POLICY",
        ]:
            monkeypatch.delenv(key, raising=False)

        config = ZaloUserConfig.from_env()
        assert config.enabled is True
        assert config.default_profile == "default"

    def test_custom_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ZALOUSER_ENABLED", "false")
        monkeypatch.setenv("ZALOUSER_DM_POLICY", "open")
        monkeypatch.setenv("ZALOUSER_ALLOWED_THREADS", "t1,t2")

        config = ZaloUserConfig.from_env()
        assert config.enabled is False
        assert config.dm_policy == "open"
        assert config.allowed_threads == ["t1", "t2"]
