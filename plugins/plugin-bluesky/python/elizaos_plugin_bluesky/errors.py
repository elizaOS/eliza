from __future__ import annotations


class BlueSkyError(Exception):
    """Base error for BlueSky operations."""

    def __init__(self, message: str, code: str = "UNKNOWN") -> None:
        super().__init__(message)
        self.code = code


class ConfigError(BlueSkyError):
    def __init__(self, message: str, field: str) -> None:
        super().__init__(message, "CONFIG_ERROR")
        self.field = field


class AuthenticationError(BlueSkyError):
    def __init__(self, message: str = "Authentication failed") -> None:
        super().__init__(message, "AUTH_FAILED")


class NetworkError(BlueSkyError):
    def __init__(self, message: str = "Network error") -> None:
        super().__init__(message, "NETWORK_ERROR")


class RateLimitError(BlueSkyError):
    def __init__(self, retry_after: int = 60) -> None:
        super().__init__(f"Rate limited. Retry after {retry_after}s.", "RATE_LIMITED")
        self.retry_after = retry_after


class PostError(BlueSkyError):
    def __init__(self, message: str, operation: str = "unknown") -> None:
        super().__init__(message, f"POST_{operation.upper()}_FAILED")
        self.operation = operation


class MessageError(BlueSkyError):
    def __init__(self, message: str, operation: str = "unknown") -> None:
        super().__init__(message, f"MESSAGE_{operation.upper()}_FAILED")
        self.operation = operation


class NotificationError(BlueSkyError):
    def __init__(self, message: str) -> None:
        super().__init__(message, "NOTIFICATION_ERROR")


class ProfileError(BlueSkyError):
    def __init__(self, message: str, handle: str) -> None:
        super().__init__(message, "PROFILE_FETCH_FAILED")
        self.handle = handle
