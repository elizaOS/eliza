import os

import pytest

from elizaos_plugin_feishu import FeishuConfig


class TestFeishuConfig:
    def test_config_creation(self):
        """Test creating a config with valid values."""
        config = FeishuConfig(
            app_id="cli_test123",
            app_secret="secret123",
        )

        assert config.app_id == "cli_test123"
        assert config.app_secret == "secret123"
        assert config.domain == "feishu"
        assert config.allowed_chats == []

    def test_api_root_feishu(self):
        """Test API root for Feishu domain."""
        config = FeishuConfig(
            app_id="cli_test123",
            app_secret="secret123",
            domain="feishu",
        )

        assert config.api_root == "https://open.feishu.cn"

    def test_api_root_lark(self):
        """Test API root for Lark domain."""
        config = FeishuConfig(
            app_id="cli_test123",
            app_secret="secret123",
            domain="lark",
        )

        assert config.api_root == "https://open.larksuite.com"

    def test_validation_valid(self):
        """Test validation with valid config."""
        config = FeishuConfig(
            app_id="cli_test123",
            app_secret="secret123",
        )

        valid, error = config.validate_config()
        assert valid is True
        assert error is None

    def test_validation_invalid_app_id_empty(self):
        """Test validation with empty app_id."""
        config = FeishuConfig(
            app_id="",
            app_secret="secret123",
        )

        valid, error = config.validate_config()
        assert valid is False
        assert "cannot be empty" in error.lower()

    def test_validation_invalid_app_id_prefix(self):
        """Test validation with invalid app_id prefix."""
        config = FeishuConfig(
            app_id="test123",
            app_secret="secret123",
        )

        valid, error = config.validate_config()
        assert valid is False
        assert "cli_" in error.lower()

    def test_validation_invalid_secret_empty(self):
        """Test validation with empty app_secret."""
        config = FeishuConfig(
            app_id="cli_test123",
            app_secret="",
        )

        valid, error = config.validate_config()
        assert valid is False
        assert "cannot be empty" in error.lower()

    def test_is_chat_allowed_empty_list(self):
        """Test chat authorization with empty allowed list."""
        config = FeishuConfig(
            app_id="cli_test123",
            app_secret="secret123",
            allowed_chats=[],
        )

        assert config.is_chat_allowed("any_chat") is True

    def test_is_chat_allowed_in_list(self):
        """Test chat authorization when chat is in allowed list."""
        config = FeishuConfig(
            app_id="cli_test123",
            app_secret="secret123",
            allowed_chats=["oc_chat1", "oc_chat2"],
        )

        assert config.is_chat_allowed("oc_chat1") is True
        assert config.is_chat_allowed("oc_chat2") is True

    def test_is_chat_allowed_not_in_list(self):
        """Test chat authorization when chat is not in allowed list."""
        config = FeishuConfig(
            app_id="cli_test123",
            app_secret="secret123",
            allowed_chats=["oc_chat1", "oc_chat2"],
        )

        assert config.is_chat_allowed("oc_chat3") is False

    def test_from_env(self, monkeypatch):
        """Test loading config from environment variables."""
        monkeypatch.setenv("FEISHU_APP_ID", "cli_env_test")
        monkeypatch.setenv("FEISHU_APP_SECRET", "env_secret")
        monkeypatch.setenv("FEISHU_DOMAIN", "lark")
        monkeypatch.setenv("FEISHU_ALLOWED_CHATS", '["oc_1", "oc_2"]')

        config = FeishuConfig.from_env()

        assert config.app_id == "cli_env_test"
        assert config.app_secret == "env_secret"
        assert config.domain == "lark"
        assert config.allowed_chats == ["oc_1", "oc_2"]

    def test_from_env_missing_app_id(self, monkeypatch):
        """Test loading config without app_id."""
        monkeypatch.delenv("FEISHU_APP_ID", raising=False)
        monkeypatch.setenv("FEISHU_APP_SECRET", "secret")

        with pytest.raises(ValueError, match="FEISHU_APP_ID"):
            FeishuConfig.from_env()

    def test_from_env_missing_app_secret(self, monkeypatch):
        """Test loading config without app_secret."""
        monkeypatch.setenv("FEISHU_APP_ID", "cli_test")
        monkeypatch.delenv("FEISHU_APP_SECRET", raising=False)

        with pytest.raises(ValueError, match="FEISHU_APP_SECRET"):
            FeishuConfig.from_env()
