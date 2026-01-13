"""
Error types for the Discord plugin.

Provides strongly-typed errors that fail fast with clear messages.
No defensive programming or error swallowing.
"""


class DiscordError(Exception):
    """Base class for Discord plugin errors."""

    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)

    def is_retryable(self) -> bool:
        """Check if this error is retryable."""
        return False

    def retry_after_ms(self) -> int | None:
        """Get retry delay in milliseconds if applicable."""
        return None


class ClientNotInitializedError(DiscordError):
    """Discord client is not initialized."""

    def __init__(self) -> None:
        super().__init__("Discord client not initialized - call start() first")


class AlreadyRunningError(DiscordError):
    """Discord client is already running."""

    def __init__(self) -> None:
        super().__init__("Discord client is already running")


class ConnectionFailedError(DiscordError):
    """Failed to connect to Discord."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"Failed to connect to Discord: {reason}")

    def is_retryable(self) -> bool:
        return True


class ConfigError(DiscordError):
    """Configuration error."""

    def __init__(self, message: str) -> None:
        super().__init__(f"Configuration error: {message}")


class MissingSettingError(DiscordError):
    """Missing required setting."""

    def __init__(self, setting_name: str) -> None:
        self.setting_name = setting_name
        super().__init__(f"Missing required setting: {setting_name}")


class InvalidSnowflakeError(DiscordError):
    """Invalid Discord snowflake ID."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"Invalid Discord snowflake: {reason}")


class InvalidArgumentError(DiscordError):
    """Invalid argument provided."""

    def __init__(self, message: str) -> None:
        super().__init__(f"Invalid argument: {message}")


class MessageTooLongError(DiscordError):
    """Message exceeds Discord's character limit."""

    def __init__(self, length: int, max_length: int) -> None:
        self.length = length
        self.max_length = max_length
        super().__init__(f"Message too long: {length} characters (max: {max_length})")


class ChannelNotFoundError(DiscordError):
    """Channel not found."""

    def __init__(self, channel_id: str) -> None:
        self.channel_id = channel_id
        super().__init__(f"Channel not found: {channel_id}")


class GuildNotFoundError(DiscordError):
    """Guild not found."""

    def __init__(self, guild_id: str) -> None:
        self.guild_id = guild_id
        super().__init__(f"Guild not found: {guild_id}")


class UserNotFoundError(DiscordError):
    """User not found."""

    def __init__(self, user_id: str) -> None:
        self.user_id = user_id
        super().__init__(f"User not found: {user_id}")


class PermissionDeniedError(DiscordError):
    """Permission denied."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"Permission denied: {reason}")


class RateLimitedError(DiscordError):
    """Rate limited by Discord API."""

    def __init__(self, retry_after_ms: int) -> None:
        self._retry_after_ms = retry_after_ms
        super().__init__(f"Rate limited by Discord API, retry after {retry_after_ms}ms")

    def is_retryable(self) -> bool:
        return True

    def retry_after_ms(self) -> int | None:
        return self._retry_after_ms


class TimeoutError(DiscordError):
    """Operation timed out."""

    def __init__(self, timeout_ms: int) -> None:
        self._timeout_ms = timeout_ms
        super().__init__(f"Operation timed out after {timeout_ms}ms")

    def is_retryable(self) -> bool:
        return True

    def retry_after_ms(self) -> int | None:
        return self._timeout_ms // 2


class ValidationError(DiscordError):
    """Action validation failed."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"Action validation failed: {reason}")
