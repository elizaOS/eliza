"""Tests for Copilot Proxy configuration."""

from __future__ import annotations

import pytest

from elizaos_plugin_copilot_proxy.config import (
    AVAILABLE_MODELS,
    DEFAULT_BASE_URL,
    DEFAULT_CONTEXT_WINDOW,
    DEFAULT_LARGE_MODEL,
    DEFAULT_MAX_TOKENS,
    DEFAULT_SMALL_MODEL,
    DEFAULT_TIMEOUT_SECONDS,
    CopilotProxyConfig,
    normalize_base_url,
)


class TestNormalizeBaseUrl:
    def test_adds_v1_suffix(self) -> None:
        assert normalize_base_url("http://localhost:3000") == "http://localhost:3000/v1"

    def test_strips_trailing_slashes_and_adds_v1(self) -> None:
        assert normalize_base_url("http://localhost:3000///") == "http://localhost:3000/v1"

    def test_preserves_existing_v1(self) -> None:
        assert normalize_base_url("http://localhost:3000/v1") == "http://localhost:3000/v1"

    def test_empty_string_returns_default(self) -> None:
        assert normalize_base_url("") == DEFAULT_BASE_URL

    def test_whitespace_only_returns_default(self) -> None:
        assert normalize_base_url("   ") == DEFAULT_BASE_URL


class TestCopilotProxyConfig:
    def test_default_values(self) -> None:
        config = CopilotProxyConfig()
        assert config.base_url == DEFAULT_BASE_URL
        assert config.small_model == DEFAULT_SMALL_MODEL
        assert config.large_model == DEFAULT_LARGE_MODEL
        assert config.enabled is True
        assert config.timeout_seconds == DEFAULT_TIMEOUT_SECONDS
        assert config.max_tokens == DEFAULT_MAX_TOKENS
        assert config.context_window == DEFAULT_CONTEXT_WINDOW

    def test_custom_values(self) -> None:
        config = CopilotProxyConfig(
            base_url="http://myserver:8080/v1",
            small_model="gpt-5-mini",
            large_model="claude-opus-4.5",
            timeout_seconds=60,
        )
        assert config.base_url == "http://myserver:8080/v1"
        assert config.large_model == "claude-opus-4.5"
        assert config.timeout_seconds == 60

    def test_base_url_auto_normalized(self) -> None:
        config = CopilotProxyConfig(base_url="http://example.com")
        assert config.base_url == "http://example.com/v1"


class TestCopilotProxyConfigFromEnv:
    def test_defaults_when_no_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for key in (
            "COPILOT_PROXY_BASE_URL",
            "COPILOT_PROXY_SMALL_MODEL",
            "COPILOT_PROXY_LARGE_MODEL",
            "COPILOT_PROXY_ENABLED",
            "COPILOT_PROXY_TIMEOUT_SECONDS",
            "COPILOT_PROXY_MAX_TOKENS",
            "COPILOT_PROXY_CONTEXT_WINDOW",
        ):
            monkeypatch.delenv(key, raising=False)

        config = CopilotProxyConfig.from_env()

        assert config.base_url == DEFAULT_BASE_URL
        assert config.small_model == DEFAULT_SMALL_MODEL
        assert config.enabled is True

    def test_reads_custom_env_vars(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("COPILOT_PROXY_BASE_URL", "http://custom:9000")
        monkeypatch.setenv("COPILOT_PROXY_SMALL_MODEL", "gpt-5-mini")
        monkeypatch.setenv("COPILOT_PROXY_LARGE_MODEL", "claude-opus-4.5")
        monkeypatch.setenv("COPILOT_PROXY_TIMEOUT_SECONDS", "30")
        monkeypatch.setenv("COPILOT_PROXY_MAX_TOKENS", "4096")

        config = CopilotProxyConfig.from_env()

        assert config.base_url == "http://custom:9000/v1"
        assert config.large_model == "claude-opus-4.5"
        assert config.timeout_seconds == 30
        assert config.max_tokens == 4096

    def test_disabled_via_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("COPILOT_PROXY_ENABLED", "false")
        config = CopilotProxyConfig.from_env()
        assert config.enabled is False

    def test_enabled_by_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("COPILOT_PROXY_ENABLED", raising=False)
        config = CopilotProxyConfig.from_env()
        assert config.enabled is True

    def test_invalid_timeout_uses_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("COPILOT_PROXY_TIMEOUT_SECONDS", "not-a-number")
        config = CopilotProxyConfig.from_env()
        assert config.timeout_seconds == DEFAULT_TIMEOUT_SECONDS


class TestAvailableModels:
    def test_not_empty(self) -> None:
        assert len(AVAILABLE_MODELS) > 0

    def test_contains_expected_models(self) -> None:
        assert "gpt-5-mini" in AVAILABLE_MODELS
        assert "gpt-5.1" in AVAILABLE_MODELS
        assert "claude-sonnet-4.5" in AVAILABLE_MODELS
