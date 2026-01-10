"""
Error types for the OpenRouter client.

All errors inherit from OpenRouterError for easy catching.
"""

from __future__ import annotations


class OpenRouterError(Exception):
    """Base exception for all OpenRouter-related errors."""

    pass


class ConfigError(OpenRouterError):
    """Configuration error."""

    pass


class ApiKeyError(OpenRouterError):
    """API key is missing or invalid."""

    def __init__(self, message: str | None = None) -> None:
        """
        Create an API key error.

        Args:
            message: Optional error message.
        """
        super().__init__(
            message
            or "OPENROUTER_API_KEY is not set. Please set it to your OpenRouter API key."
        )


class NetworkError(OpenRouterError):
    """Network-related error."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        """
        Create a network error.

        Args:
            message: Error message.
            status_code: Optional HTTP status code.
        """
        self.status_code = status_code
        super().__init__(message)


class RateLimitError(OpenRouterError):
    """Rate limit exceeded."""

    def __init__(self, retry_after_seconds: int = 60) -> None:
        """
        Create a rate limit error.

        Args:
            retry_after_seconds: Seconds to wait before retrying.
        """
        self.retry_after_seconds = retry_after_seconds
        super().__init__(f"Rate limit exceeded. Retry after {retry_after_seconds} seconds.")

