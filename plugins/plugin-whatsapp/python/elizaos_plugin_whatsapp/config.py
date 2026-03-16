"""Configuration for the WhatsApp plugin."""

import os
from typing import Self

from pydantic import BaseModel, Field, model_validator

WHATSAPP_API_BASE_URL = "https://graph.facebook.com/v17.0"


class WhatsAppConfig(BaseModel):
    """WhatsApp plugin configuration."""

    access_token: str = Field(description="WhatsApp Cloud API access token")
    phone_number_id: str = Field(description="Phone number ID")
    webhook_verify_token: str | None = Field(
        default=None, description="Webhook verification token"
    )
    business_id: str | None = Field(default=None, description="Business account ID")
    api_version: str = Field(default="v17.0", description="API version")
    enabled: bool = Field(default=True, description="Whether the plugin is enabled")

    @model_validator(mode="after")
    def validate_config(self) -> Self:
        """Validates the configuration."""
        if not self.access_token:
            raise ValueError("Access token is required")
        if not self.phone_number_id:
            raise ValueError("Phone number ID is required")
        return self

    @property
    def api_base_url(self) -> str:
        """Gets the API base URL."""
        return f"https://graph.facebook.com/{self.api_version}"


def get_config_from_env() -> WhatsAppConfig | None:
    """Gets WhatsApp configuration from environment variables."""
    access_token = os.getenv("WHATSAPP_ACCESS_TOKEN")
    phone_number_id = os.getenv("WHATSAPP_PHONE_NUMBER_ID")

    if not access_token or not phone_number_id:
        return None

    return WhatsAppConfig(
        access_token=access_token,
        phone_number_id=phone_number_id,
        webhook_verify_token=os.getenv("WHATSAPP_WEBHOOK_TOKEN"),
        business_id=os.getenv("WHATSAPP_BUSINESS_ID"),
        enabled=os.getenv("WHATSAPP_ENABLED", "true").lower() != "false",
    )
