"""
GitHub plugin configuration.

Configuration can be loaded from environment variables or constructed programmatically.
"""

import os
from typing import Optional

from pydantic import BaseModel, ConfigDict, field_validator

from elizaos_plugin_github.error import ConfigError, MissingSettingError


class GitHubConfig(BaseModel):
    """
    GitHub plugin configuration.

    Contains all settings required to interact with the GitHub API.
    """

    model_config = ConfigDict(frozen=True)

    # Required fields
    api_token: str

    # Optional fields with defaults
    owner: Optional[str] = None
    repo: Optional[str] = None
    branch: str = "main"
    webhook_secret: Optional[str] = None
    app_id: Optional[str] = None
    app_private_key: Optional[str] = None
    installation_id: Optional[str] = None

    @field_validator("api_token")
    @classmethod
    def validate_api_token(cls, v: str) -> str:
        if not v or not v.strip():
            raise ConfigError("API token cannot be empty")
        return v

    @classmethod
    def from_env(cls) -> "GitHubConfig":
        """
        Load configuration from environment variables.

        Required Variables:
            - GITHUB_API_TOKEN: Personal access token

        Optional Variables:
            - GITHUB_OWNER: Default repository owner
            - GITHUB_REPO: Default repository name
            - GITHUB_BRANCH: Default branch (defaults to main)
            - GITHUB_WEBHOOK_SECRET: Webhook secret for verification
            - GITHUB_APP_ID: GitHub App ID
            - GITHUB_APP_PRIVATE_KEY: GitHub App private key
            - GITHUB_INSTALLATION_ID: GitHub App installation ID

        Raises:
            MissingSettingError: If required variables are missing.
            ConfigError: If configuration is invalid.
        """
        api_token = os.environ.get("GITHUB_API_TOKEN")
        if not api_token:
            raise MissingSettingError("GITHUB_API_TOKEN")

        return cls(
            api_token=api_token,
            owner=os.environ.get("GITHUB_OWNER"),
            repo=os.environ.get("GITHUB_REPO"),
            branch=os.environ.get("GITHUB_BRANCH", "main"),
            webhook_secret=os.environ.get("GITHUB_WEBHOOK_SECRET"),
            app_id=os.environ.get("GITHUB_APP_ID"),
            app_private_key=os.environ.get("GITHUB_APP_PRIVATE_KEY"),
            installation_id=os.environ.get("GITHUB_INSTALLATION_ID"),
        )

    def get_repository_ref(
        self, owner: Optional[str] = None, repo: Optional[str] = None
    ) -> tuple[str, str]:
        """
        Get repository reference, falling back to defaults.

        Args:
            owner: Optional owner override
            repo: Optional repo override

        Returns:
            Tuple of (owner, repo)

        Raises:
            MissingSettingError: If neither override nor default is available
        """
        resolved_owner = owner or self.owner
        resolved_repo = repo or self.repo

        if not resolved_owner:
            raise MissingSettingError("owner (GITHUB_OWNER)")

        if not resolved_repo:
            raise MissingSettingError("repo (GITHUB_REPO)")

        return resolved_owner, resolved_repo

    def has_app_auth(self) -> bool:
        """Check if GitHub App authentication is configured."""
        return bool(self.app_id and self.app_private_key)

    def validate_all(self) -> None:
        """
        Validate all configuration values.

        Raises:
            ConfigError: If configuration is invalid.
        """
        if self.has_app_auth() and not self.installation_id:
            raise ConfigError(
                "GITHUB_INSTALLATION_ID is required when using GitHub App authentication"
            )


