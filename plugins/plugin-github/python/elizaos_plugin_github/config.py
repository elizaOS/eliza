import os

from pydantic import BaseModel, ConfigDict, field_validator

from elizaos_plugin_github.error import ConfigError, MissingSettingError


class GitHubConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    # Required fields
    api_token: str

    # Optional fields with defaults
    owner: str | None = None
    repo: str | None = None
    branch: str = "main"
    webhook_secret: str | None = None
    app_id: str | None = None
    app_private_key: str | None = None
    installation_id: str | None = None

    @field_validator("api_token")
    @classmethod
    def validate_api_token(cls, v: str) -> str:
        if not v or not v.strip():
            raise ConfigError("API token cannot be empty")
        return v

    @classmethod
    def from_env(cls) -> "GitHubConfig":
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
        self, owner: str | None = None, repo: str | None = None
    ) -> tuple[str, str]:
        resolved_owner = owner or self.owner
        resolved_repo = repo or self.repo

        if not resolved_owner:
            raise MissingSettingError("owner (GITHUB_OWNER)")

        if not resolved_repo:
            raise MissingSettingError("repo (GITHUB_REPO)")

        return resolved_owner, resolved_repo

    def has_app_auth(self) -> bool:
        return bool(self.app_id and self.app_private_key)

    def validate_all(self) -> None:
        if self.has_app_auth() and not self.installation_id:
            raise ConfigError(
                "GITHUB_INSTALLATION_ID is required when using GitHub App authentication"
            )
