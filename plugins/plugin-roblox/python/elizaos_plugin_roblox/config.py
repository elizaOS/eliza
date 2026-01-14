import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

from elizaos_plugin_roblox.error import ConfigError

DEFAULT_MESSAGING_TOPIC = "eliza-agent"
DEFAULT_POLL_INTERVAL = 30


@dataclass
class RobloxConfig:
    api_key: str
    universe_id: str
    place_id: str | None = None
    webhook_secret: str | None = None
    messaging_topic: str = field(default=DEFAULT_MESSAGING_TOPIC)
    poll_interval: int = field(default=DEFAULT_POLL_INTERVAL)
    dry_run: bool = False

    @classmethod
    def from_env(cls) -> "RobloxConfig":
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
        if not self.api_key:
            raise ConfigError("API key cannot be empty")

        if not self.universe_id:
            raise ConfigError("Universe ID cannot be empty")
