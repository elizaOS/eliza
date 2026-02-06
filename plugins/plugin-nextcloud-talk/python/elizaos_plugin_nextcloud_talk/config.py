import json
import os

from pydantic import BaseModel, Field


class NextcloudTalkConfig(BaseModel):
    """Configuration for the Nextcloud Talk plugin."""

    base_url: str
    bot_secret: str
    enabled: bool = Field(default=True)
    webhook_port: int = Field(default=8788)
    webhook_host: str = Field(default="0.0.0.0")
    webhook_path: str = Field(default="/nextcloud-talk-webhook")
    webhook_public_url: str | None = None
    allowed_rooms: list[str] = Field(default_factory=list)

    @classmethod
    def from_env(cls) -> "NextcloudTalkConfig":
        """Load configuration from environment variables."""
        base_url = os.getenv("NEXTCLOUD_URL")
        if not base_url:
            raise ValueError("NEXTCLOUD_URL environment variable is required")

        bot_secret = os.getenv("NEXTCLOUD_BOT_SECRET")
        if not bot_secret:
            raise ValueError("NEXTCLOUD_BOT_SECRET environment variable is required")

        enabled_str = os.getenv("NEXTCLOUD_ENABLED", "true")
        enabled = enabled_str.lower() == "true"

        webhook_port = int(os.getenv("NEXTCLOUD_WEBHOOK_PORT", "8788"))
        webhook_host = os.getenv("NEXTCLOUD_WEBHOOK_HOST", "0.0.0.0")
        webhook_path = os.getenv("NEXTCLOUD_WEBHOOK_PATH", "/nextcloud-talk-webhook")
        webhook_public_url = os.getenv("NEXTCLOUD_WEBHOOK_PUBLIC_URL")

        allowed_rooms_str = os.getenv("NEXTCLOUD_ALLOWED_ROOMS", "[]")
        allowed_rooms = _parse_allowed_rooms(allowed_rooms_str)

        return cls(
            base_url=base_url,
            bot_secret=bot_secret,
            enabled=enabled,
            webhook_port=webhook_port,
            webhook_host=webhook_host,
            webhook_path=webhook_path,
            webhook_public_url=webhook_public_url,
            allowed_rooms=allowed_rooms,
        )

    def is_room_allowed(self, room_token: str) -> bool:
        """Check if a room token is in the allowlist (empty = allow all)."""
        if not self.allowed_rooms:
            return True
        return room_token in self.allowed_rooms

    def validate_config(self) -> None:
        """Validate configuration values."""
        if not self.base_url:
            raise ValueError("base_url cannot be empty")
        if not self.bot_secret:
            raise ValueError("bot_secret cannot be empty")
        if not self.base_url.startswith(("http://", "https://")):
            raise ValueError("base_url must start with http:// or https://")


def _parse_allowed_rooms(value: str) -> list[str]:
    """Parse allowed rooms from JSON array or comma-separated string."""
    value = value.strip()
    if not value:
        return []

    # Try parsing as JSON array first
    if value.startswith("["):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return [str(item) for item in parsed if item]
        except json.JSONDecodeError:
            pass

    # Otherwise parse as comma-separated
    return [s.strip() for s in value.split(",") if s.strip()]
