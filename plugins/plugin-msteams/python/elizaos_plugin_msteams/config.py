"""Configuration types and helpers for the MS Teams plugin."""

import json
import os
from typing import Self

from pydantic import BaseModel, Field


class MSTeamsConfig(BaseModel):
    """Configuration options for the MS Teams plugin."""

    app_id: str = Field(description="Bot App ID from Azure Bot registration")
    app_password: str = Field(description="Bot App Password/Secret")
    tenant_id: str = Field(description="Azure AD Tenant ID")
    enabled: bool = Field(default=True, description="Whether the plugin is enabled")
    webhook_port: int = Field(default=3978, description="Webhook server port")
    webhook_path: str = Field(default="/api/messages", description="Webhook endpoint path")
    allowed_tenants: list[str] = Field(
        default_factory=list, description="Allowed tenant IDs for multi-tenant bots"
    )
    sharepoint_site_id: str | None = Field(
        default=None, description="SharePoint site ID for file uploads"
    )
    media_max_mb: int = Field(default=100, description="Maximum media file size in MB")

    @classmethod
    def from_env(cls) -> Self:
        """Load configuration from environment variables.

        Required:
            MSTEAMS_APP_ID
            MSTEAMS_APP_PASSWORD
            MSTEAMS_TENANT_ID

        Optional:
            MSTEAMS_ENABLED (default: true)
            MSTEAMS_WEBHOOK_PORT (default: 3978)
            MSTEAMS_WEBHOOK_PATH (default: /api/messages)
            MSTEAMS_ALLOWED_TENANTS (JSON array)
            MSTEAMS_SHAREPOINT_SITE_ID
            MSTEAMS_MEDIA_MAX_MB (default: 100)
        """
        app_id = os.getenv("MSTEAMS_APP_ID")
        if not app_id:
            raise ValueError("MSTEAMS_APP_ID environment variable is required")

        app_password = os.getenv("MSTEAMS_APP_PASSWORD")
        if not app_password:
            raise ValueError("MSTEAMS_APP_PASSWORD environment variable is required")

        tenant_id = os.getenv("MSTEAMS_TENANT_ID")
        if not tenant_id:
            raise ValueError("MSTEAMS_TENANT_ID environment variable is required")

        enabled_str = os.getenv("MSTEAMS_ENABLED", "true")
        enabled = enabled_str.lower() == "true"

        webhook_port = int(os.getenv("MSTEAMS_WEBHOOK_PORT", "3978"))
        webhook_path = os.getenv("MSTEAMS_WEBHOOK_PATH", "/api/messages")

        allowed_tenants_str = os.getenv("MSTEAMS_ALLOWED_TENANTS", "[]")
        try:
            allowed_tenants = json.loads(allowed_tenants_str)
            if not isinstance(allowed_tenants, list):
                allowed_tenants = []
        except json.JSONDecodeError:
            allowed_tenants = []

        sharepoint_site_id = os.getenv("MSTEAMS_SHAREPOINT_SITE_ID")
        media_max_mb = int(os.getenv("MSTEAMS_MEDIA_MAX_MB", "100"))

        return cls(
            app_id=app_id,
            app_password=app_password,
            tenant_id=tenant_id,
            enabled=enabled,
            webhook_port=webhook_port,
            webhook_path=webhook_path,
            allowed_tenants=allowed_tenants,
            sharepoint_site_id=sharepoint_site_id,
            media_max_mb=media_max_mb,
        )

    def is_tenant_allowed(self, tenant_id: str) -> bool:
        """Check if a tenant ID is allowed by the configuration."""
        if not self.allowed_tenants:
            return True
        return tenant_id in self.allowed_tenants

    def validate_config(self) -> None:
        """Validate the configuration values."""
        if not self.app_id:
            raise ValueError("App ID cannot be empty")
        if not self.app_password:
            raise ValueError("App Password cannot be empty")
        if not self.tenant_id:
            raise ValueError("Tenant ID cannot be empty")


class MSTeamsCredentials(BaseModel):
    """MS Teams credentials for authentication."""

    app_id: str
    app_password: str
    tenant_id: str

    @classmethod
    def from_config(cls, config: MSTeamsConfig) -> Self:
        """Create credentials from configuration."""
        return cls(
            app_id=config.app_id,
            app_password=config.app_password,
            tenant_id=config.tenant_id,
        )
