"""Error types for the Zalo plugin."""


class ZaloError(Exception):
    """Base exception for Zalo plugin errors."""

    pass


class ConfigError(ZaloError):
    """Configuration error."""

    pass


class ApiError(ZaloError):
    """API error from Zalo."""

    def __init__(self, message: str, error_code: int | None = None) -> None:
        super().__init__(message)
        self.error_code = error_code


class ClientNotInitializedError(ZaloError):
    """Client not initialized error."""

    def __init__(self) -> None:
        super().__init__("Zalo client not initialized")


class MessageSendError(ZaloError):
    """Failed to send message."""

    def __init__(self, user_id: str, cause: Exception | None = None) -> None:
        super().__init__(f"Failed to send message to {user_id}")
        self.user_id = user_id
        self.cause = cause


class TokenRefreshError(ZaloError):
    """Token refresh failed."""

    pass


class UserNotFoundError(ZaloError):
    """User not found."""

    def __init__(self, user_id: str) -> None:
        super().__init__(f"User not found: {user_id}")
        self.user_id = user_id
