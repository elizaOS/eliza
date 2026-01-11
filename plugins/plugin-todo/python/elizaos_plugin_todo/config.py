"""
Configuration for the Todo Plugin.
"""

import os
from dataclasses import dataclass, field
from typing import Optional

from elizaos_plugin_todo.errors import ConfigError


@dataclass
class TodoConfig:
    """Configuration for the Todo plugin."""

    # Database configuration
    database_url: Optional[str] = None

    # Reminder settings
    enable_reminders: bool = True
    reminder_interval_ms: int = 30000  # 30 seconds
    min_reminder_interval_ms: int = 1800000  # 30 minutes between reminders per task

    # Notification settings
    enable_browser_notifications: bool = False
    enable_sound: bool = True
    quiet_hours_start: int = 22  # 10 PM
    quiet_hours_end: int = 8  # 8 AM

    # Cache settings
    cache_max_size: int = 1000
    cache_default_ttl_ms: int = 300000  # 5 minutes

    # Integration settings
    enable_rolodex_integration: bool = True

    @classmethod
    def from_env(cls) -> "TodoConfig":
        """
        Create configuration from environment variables.

        Environment variables:
            DATABASE_URL: Database connection string
            TODO_ENABLE_REMINDERS: Enable reminder notifications (default: true)
            TODO_REMINDER_INTERVAL_MS: Reminder check interval (default: 30000)
            TODO_MIN_REMINDER_INTERVAL_MS: Min interval between reminders (default: 1800000)
            TODO_ENABLE_BROWSER_NOTIFICATIONS: Enable browser notifications (default: false)
            TODO_QUIET_HOURS_START: Quiet hours start hour (default: 22)
            TODO_QUIET_HOURS_END: Quiet hours end hour (default: 8)
            TODO_CACHE_MAX_SIZE: Maximum cache entries (default: 1000)
            TODO_ENABLE_ROLODEX: Enable rolodex integration (default: true)

        Returns:
            TodoConfig: Configured instance

        Raises:
            ConfigError: If required configuration is missing
        """
        return cls(
            database_url=os.getenv("DATABASE_URL"),
            enable_reminders=os.getenv("TODO_ENABLE_REMINDERS", "true").lower() == "true",
            reminder_interval_ms=int(os.getenv("TODO_REMINDER_INTERVAL_MS", "30000")),
            min_reminder_interval_ms=int(os.getenv("TODO_MIN_REMINDER_INTERVAL_MS", "1800000")),
            enable_browser_notifications=os.getenv(
                "TODO_ENABLE_BROWSER_NOTIFICATIONS", "false"
            ).lower()
            == "true",
            enable_sound=os.getenv("TODO_ENABLE_SOUND", "true").lower() == "true",
            quiet_hours_start=int(os.getenv("TODO_QUIET_HOURS_START", "22")),
            quiet_hours_end=int(os.getenv("TODO_QUIET_HOURS_END", "8")),
            cache_max_size=int(os.getenv("TODO_CACHE_MAX_SIZE", "1000")),
            cache_default_ttl_ms=int(os.getenv("TODO_CACHE_DEFAULT_TTL_MS", "300000")),
            enable_rolodex_integration=os.getenv("TODO_ENABLE_ROLODEX", "true").lower() == "true",
        )

    def validate(self) -> None:
        """
        Validate the configuration.

        Raises:
            ConfigError: If configuration is invalid
        """
        if self.reminder_interval_ms < 1000:
            raise ConfigError("reminder_interval_ms must be at least 1000ms")

        if self.min_reminder_interval_ms < 60000:
            raise ConfigError("min_reminder_interval_ms must be at least 60000ms (1 minute)")

        if not 0 <= self.quiet_hours_start <= 23:
            raise ConfigError("quiet_hours_start must be between 0 and 23")

        if not 0 <= self.quiet_hours_end <= 23:
            raise ConfigError("quiet_hours_end must be between 0 and 23")

        if self.cache_max_size < 10:
            raise ConfigError("cache_max_size must be at least 10")


