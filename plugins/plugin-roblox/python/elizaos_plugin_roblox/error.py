"""Error types for the Roblox plugin."""


class RobloxError(Exception):
    """Base exception for Roblox plugin errors."""

    pass


class ConfigError(RobloxError):
    """Configuration error."""

    pass


class ApiError(RobloxError):
    """API request error."""

    def __init__(
        self,
        message: str,
        status_code: int,
        endpoint: str,
        details: str | None = None,
    ) -> None:
        """Initialize API error."""
        super().__init__(message)
        self.status_code = status_code
        self.endpoint = endpoint
        self.details = details


class NetworkError(RobloxError):
    """Network error."""

    pass


class ValidationError(RobloxError):
    """Validation error."""

    pass


class RateLimitError(RobloxError):
    """Rate limit exceeded error."""

    def __init__(self, message: str, retry_after: int | None = None) -> None:
        """Initialize rate limit error."""
        super().__init__(message)
        self.retry_after = retry_after


