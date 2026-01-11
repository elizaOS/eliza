"""
Error types for the Anthropic client.

All errors are strongly typed with specific error classes.
No generic exception catching - fail fast with actionable information.
"""

from __future__ import annotations


class AnthropicError(Exception):
    """Base exception for all Anthropic client errors."""

    def __init__(self, message: str) -> None:
        """Initialize the error with a message."""
        super().__init__(message)
        self.message = message

    def is_retryable(self) -> bool:
        """Check if this error can be retried."""
        return False


class ApiKeyError(AnthropicError):
    """API key is missing or invalid."""

    def __init__(self, message: str = "API key is missing or invalid") -> None:
        """Initialize with an API key error message."""
        super().__init__(f"API key error: {message}")


class ConfigError(AnthropicError):
    """Configuration error."""

    def __init__(self, message: str) -> None:
        """Initialize with a configuration error message."""
        super().__init__(f"Configuration error: {message}")


class NetworkError(AnthropicError):
    """Network-related error."""

    def __init__(self, message: str) -> None:
        """Initialize with a network error message."""
        super().__init__(f"Network error: {message}")

    def is_retryable(self) -> bool:
        """Network errors can be retried."""
        return True


class RateLimitError(AnthropicError):
    """Rate limit exceeded."""

    retry_after_seconds: int

    def __init__(self, retry_after_seconds: int = 60) -> None:
        """Initialize with retry delay information."""
        super().__init__(f"Rate limit exceeded: retry after {retry_after_seconds} seconds")
        self.retry_after_seconds = retry_after_seconds

    def is_retryable(self) -> bool:
        """Rate limit errors can be retried after waiting."""
        return True


class ApiError(AnthropicError):
    """Error returned by the Anthropic API."""

    error_type: str
    status_code: int | None

    def __init__(
        self,
        error_type: str,
        message: str,
        status_code: int | None = None,
    ) -> None:
        """Initialize with API error details."""
        super().__init__(f"API error ({error_type}): {message}")
        self.error_type = error_type
        self.status_code = status_code


class JsonGenerationError(AnthropicError):
    """Failed to generate or parse JSON from model response."""

    raw_response: str | None

    def __init__(self, message: str, raw_response: str | None = None) -> None:
        """Initialize with JSON generation error details."""
        super().__init__(f"JSON generation error: {message}")
        self.raw_response = raw_response


class InvalidParameterError(AnthropicError):
    """Invalid parameter provided."""

    parameter: str

    def __init__(self, parameter: str, message: str) -> None:
        """Initialize with parameter validation error details."""
        super().__init__(f"Invalid parameter '{parameter}': {message}")
        self.parameter = parameter


class TimeoutError(AnthropicError):
    """Request timed out."""

    timeout_seconds: int

    def __init__(self, timeout_seconds: int) -> None:
        """Initialize with timeout information."""
        super().__init__(f"Request timed out after {timeout_seconds} seconds")
        self.timeout_seconds = timeout_seconds

    def is_retryable(self) -> bool:
        """Timeout errors can be retried."""
        return True


class ServerError(AnthropicError):
    """Server error (5xx status codes)."""

    status_code: int

    def __init__(self, status_code: int, message: str) -> None:
        """Initialize with server error details."""
        super().__init__(f"Server error ({status_code}): {message}")
        self.status_code = status_code

    def is_retryable(self) -> bool:
        """Server errors can be retried."""
        return True
