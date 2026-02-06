"""Custom exception types for the webhooks plugin."""

from __future__ import annotations


class WebhooksError(Exception):
    """Base exception for all webhooks plugin errors."""

    def __init__(self, message: str, status_code: int = 500) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class AuthenticationError(WebhooksError):
    """Raised when token validation fails."""

    def __init__(self, message: str = "Unauthorized") -> None:
        super().__init__(message, status_code=401)


class ConfigurationError(WebhooksError):
    """Raised when hooks configuration is missing or invalid."""

    def __init__(self, message: str = "Hooks not enabled") -> None:
        super().__init__(message, status_code=404)


class ValidationError(WebhooksError):
    """Raised when request validation fails (missing fields, bad input)."""

    def __init__(self, message: str = "Validation failed") -> None:
        super().__init__(message, status_code=400)


class MappingNotFoundError(WebhooksError):
    """Raised when no mapping matches the incoming webhook."""

    def __init__(self, hook_name: str) -> None:
        super().__init__(f"No mapping found for hook: {hook_name}", status_code=404)
        self.hook_name = hook_name


class AgentTurnTimeoutError(WebhooksError):
    """Raised when an agent turn exceeds its timeout."""

    def __init__(self, timeout_seconds: float) -> None:
        super().__init__(
            f"Agent turn timed out after {timeout_seconds}s", status_code=504
        )
        self.timeout_seconds = timeout_seconds
