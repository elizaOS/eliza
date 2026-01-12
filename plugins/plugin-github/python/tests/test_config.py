"""Tests for GitHub config."""

import pytest

from elizaos_plugin_github.config import GitHubConfig
from elizaos_plugin_github.error import ConfigError, MissingSettingError


class TestGitHubConfig:
    """Test cases for GitHubConfig."""

    def test_create_with_token(self):
        """Test creating config with API token."""
        config = GitHubConfig(api_token="test_token")
        assert config.api_token == "test_token"
        assert config.branch == "main"
        assert config.owner is None
        assert config.repo is None

    def test_create_with_all_fields(self):
        """Test creating config with all fields."""
        config = GitHubConfig(
            api_token="test_token",
            owner="test_owner",
            repo="test_repo",
            branch="develop",
        )
        assert config.api_token == "test_token"
        assert config.owner == "test_owner"
        assert config.repo == "test_repo"
        assert config.branch == "develop"

    def test_from_env(self, monkeypatch):
        """Test loading config from environment."""
        monkeypatch.setenv("GITHUB_API_TOKEN", "env_token")
        monkeypatch.setenv("GITHUB_OWNER", "env_owner")
        monkeypatch.setenv("GITHUB_REPO", "env_repo")
        monkeypatch.setenv("GITHUB_BRANCH", "env_branch")

        config = GitHubConfig.from_env()
        assert config.api_token == "env_token"
        assert config.owner == "env_owner"
        assert config.repo == "env_repo"
        assert config.branch == "env_branch"

    def test_from_env_missing_token(self, monkeypatch):
        """Test that missing token raises error."""
        monkeypatch.delenv("GITHUB_API_TOKEN", raising=False)

        with pytest.raises(MissingSettingError, match="GITHUB_API_TOKEN"):
            GitHubConfig.from_env()

    def test_from_env_default_branch(self, monkeypatch):
        """Test default branch when not in environment."""
        monkeypatch.setenv("GITHUB_API_TOKEN", "token")
        monkeypatch.delenv("GITHUB_BRANCH", raising=False)

        config = GitHubConfig.from_env()
        assert config.branch == "main"

    def test_get_repository_ref_with_defaults(self):
        """Test getting repository reference with defaults."""
        config = GitHubConfig(
            api_token="token",
            owner="default_owner",
            repo="default_repo",
        )

        owner, repo = config.get_repository_ref()
        assert owner == "default_owner"
        assert repo == "default_repo"

    def test_get_repository_ref_with_override(self):
        """Test getting repository reference with overrides."""
        config = GitHubConfig(
            api_token="token",
            owner="default_owner",
            repo="default_repo",
        )

        owner, repo = config.get_repository_ref(
            owner="override_owner",
            repo="override_repo",
        )
        assert owner == "override_owner"
        assert repo == "override_repo"

    def test_get_repository_ref_missing(self):
        """Test error when no repository configured."""
        config = GitHubConfig(api_token="token")

        with pytest.raises(MissingSettingError, match="owner"):
            config.get_repository_ref()

    def test_validate_all_success(self):
        """Test successful validation."""
        config = GitHubConfig(api_token="valid_token")
        config.validate_all()  # Should not raise

    def test_validate_empty_token(self):
        """Test validation fails with empty token during construction."""
        with pytest.raises(ConfigError, match="empty"):
            GitHubConfig(api_token="")
