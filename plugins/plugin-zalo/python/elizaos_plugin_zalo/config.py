"""Configuration types and helpers for the Zalo plugin."""

import os
from typing import Literal

from pydantic import BaseModel, Field


UpdateMode = Literal["polling", "webhook"]

DEFAULT_WEBHOOK_PATH = "/zalo/webhook"
DEFAULT_WEBHOOK_PORT = 3000


class ZaloConfig(BaseModel):
    """Configuration for the Zalo plugin."""

    app_id: str
    secret_key: str
    access_token: str
    refresh_token: str | None = None
    webhook_url: str | None = None
    webhook_path: str = Field(default=DEFAULT_WEBHOOK_PATH)
    webhook_port: int = Field(default=DEFAULT_WEBHOOK_PORT)
    use_polling: bool = False
    enabled: bool = True
    proxy_url: str | None = None

    @classmethod
    def from_env(cls) -> "ZaloConfig":
        """Load configuration from environment variables."""
        app_id = os.getenv("ZALO_APP_ID")
        if not app_id:
            raise ValueError("ZALO_APP_ID environment variable is required")

        secret_key = os.getenv("ZALO_SECRET_KEY")
        if not secret_key:
            raise ValueError("ZALO_SECRET_KEY environment variable is required")

        access_token = os.getenv("ZALO_ACCESS_TOKEN")
        if not access_token:
            raise ValueError("ZALO_ACCESS_TOKEN environment variable is required")

        refresh_token = os.getenv("ZALO_REFRESH_TOKEN")
        webhook_url = os.getenv("ZALO_WEBHOOK_URL")
        webhook_path = os.getenv("ZALO_WEBHOOK_PATH", DEFAULT_WEBHOOK_PATH)
        
        webhook_port_str = os.getenv("ZALO_WEBHOOK_PORT")
        webhook_port = int(webhook_port_str) if webhook_port_str else DEFAULT_WEBHOOK_PORT

        use_polling = os.getenv("ZALO_USE_POLLING", "false").lower() == "true"
        enabled = os.getenv("ZALO_ENABLED", "true").lower() != "false"
        proxy_url = os.getenv("ZALO_PROXY_URL")

        return cls(
            app_id=app_id,
            secret_key=secret_key,
            access_token=access_token,
            refresh_token=refresh_token,
            webhook_url=webhook_url,
            webhook_path=webhook_path,
            webhook_port=webhook_port,
            use_polling=use_polling,
            enabled=enabled,
            proxy_url=proxy_url,
        )

    def validate_config(self) -> None:
        """Validate the configuration."""
        if not self.app_id:
            raise ValueError("App ID cannot be empty")
        if not self.secret_key:
            raise ValueError("Secret key cannot be empty")
        if not self.access_token:
            raise ValueError("Access token cannot be empty")
        if not self.use_polling and not self.webhook_url:
            raise ValueError("Webhook URL is required when not using polling mode")

    @property
    def update_mode(self) -> UpdateMode:
        """Returns the update mode."""
        return "polling" if self.use_polling else "webhook"
