"""Configuration for the Roblox plugin."""

import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

from elizaos_plugin_roblox.error import ConfigError

# Default values
DEFAULT_MESSAGING_TOPIC = "eliza-agent"
DEFAULT_POLL_INTERVAL = 30


@dataclass
class RobloxConfig:
    """Configuration for the Roblox plugin."""

    api_key: str
    """API key for Roblox Open Cloud API."""

    universe_id: str
    """Universe ID of the experience."""

    place_id: str | None = None
    """Optional Place ID."""

    webhook_secret: str | None = None
    """Webhook secret for validation."""

    messaging_topic: str = field(default=DEFAULT_MESSAGING_TOPIC)
    """Messaging service topic."""

    poll_interval: int = field(default=DEFAULT_POLL_INTERVAL)
    """Polling interval in seconds."""

    dry_run: bool = False
    """Dry run mode."""

    @classmethod
    def from_env(cls) -> "RobloxConfig":
        """Load configuration from environment variables.

        Required:
            ROBLOX_API_KEY: API key for Roblox Open Cloud API
            ROBLOX_UNIVERSE_ID: Universe ID of the experience

        Optional:
            ROBLOX_PLACE_ID: Specific place ID
            ROBLOX_WEBHOOK_SECRET: Secret for webhook validation
            ROBLOX_MESSAGING_TOPIC: Messaging topic (default: "eliza-agent")
            ROBLOX_POLL_INTERVAL: Poll interval in seconds (default: 30)
            ROBLOX_DRY_RUN: Enable dry run mode (default: false)

        Returns:
            RobloxConfig instance.

        Raises:
            ConfigError: If required environment variables are missing.
        """
        load_dotenv()

        api_key = os.getenv("ROBLOX_API_KEY")
        if not api_key:
            raise ConfigError("ROBLOX_API_KEY is required")

        universe_id = os.getenv("ROBLOX_UNIVERSE_ID")
        if not universe_id:
            raise ConfigError("ROBLOX_UNIVERSE_ID is required")

        place_id = os.getenv("ROBLOX_PLACE_ID")
        webhook_secret = os.getenv("ROBLOX_WEBHOOK_SECRET")
        messaging_topic = os.getenv("ROBLOX_MESSAGING_TOPIC", DEFAULT_MESSAGING_TOPIC)

        poll_interval_str = os.getenv("ROBLOX_POLL_INTERVAL")
        poll_interval = int(poll_interval_str) if poll_interval_str else DEFAULT_POLL_INTERVAL

        dry_run = os.getenv("ROBLOX_DRY_RUN", "").lower() == "true"

        return cls(
            api_key=api_key,
            universe_id=universe_id,
            place_id=place_id,
            webhook_secret=webhook_secret,
            messaging_topic=messaging_topic,
            poll_interval=poll_interval,
            dry_run=dry_run,
        )

    def validate(self) -> None:
        """Validate the configuration.

        Raises:
            ConfigError: If configuration is invalid.
        """
        if not self.api_key:
            raise ConfigError("API key cannot be empty")

        if not self.universe_id:
            raise ConfigError("Universe ID cannot be empty")

