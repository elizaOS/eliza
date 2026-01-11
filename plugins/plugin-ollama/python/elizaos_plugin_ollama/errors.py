"""
Error types for the Ollama client.

All errors inherit from OllamaError for easy catching.
"""

from __future__ import annotations


class OllamaError(Exception):
    """Base exception for all Ollama-related errors."""

    pass


class ConfigError(OllamaError):
    """Configuration error."""

    pass


class ConnectionError(OllamaError):
    """Failed to connect to Ollama server."""

    def __init__(self, url: str, message: str | None = None) -> None:
        """
        Create a connection error.

        Args:
            url: The URL that failed to connect.
            message: Optional additional message.
        """
        self.url = url
        msg = f"Failed to connect to Ollama at {url}"
        if message:
            msg = f"{msg}: {message}"
        super().__init__(msg)


class NetworkError(OllamaError):
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


class ModelNotFoundError(OllamaError):
    """Requested model is not available."""

    def __init__(self, model: str) -> None:
        """
        Create a model not found error.

        Args:
            model: The model that was not found.
        """
        self.model = model
        super().__init__(f"Model '{model}' not found. Try: ollama pull {model}")


