from __future__ import annotations


class AnthropicError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message

    def is_retryable(self) -> bool:
        return False


class ApiKeyError(AnthropicError):
    def __init__(self, message: str = "API key is missing or invalid") -> None:
        super().__init__(f"API key error: {message}")


class ConfigError(AnthropicError):
    def __init__(self, message: str) -> None:
        super().__init__(f"Configuration error: {message}")


class NetworkError(AnthropicError):
    def __init__(self, message: str) -> None:
        super().__init__(f"Network error: {message}")

    def is_retryable(self) -> bool:
        return True


class RateLimitError(AnthropicError):
    retry_after_seconds: int

    def __init__(self, retry_after_seconds: int = 60) -> None:
        super().__init__(f"Rate limit exceeded: retry after {retry_after_seconds} seconds")
        self.retry_after_seconds = retry_after_seconds

    def is_retryable(self) -> bool:
        return True


class ApiError(AnthropicError):
    error_type: str
    status_code: int | None

    def __init__(
        self,
        error_type: str,
        message: str,
        status_code: int | None = None,
    ) -> None:
        super().__init__(f"API error ({error_type}): {message}")
        self.error_type = error_type
        self.status_code = status_code


class JsonGenerationError(AnthropicError):
    raw_response: str | None

    def __init__(self, message: str, raw_response: str | None = None) -> None:
        super().__init__(f"JSON generation error: {message}")
        self.raw_response = raw_response


class InvalidParameterError(AnthropicError):
    parameter: str

    def __init__(self, parameter: str, message: str) -> None:
        super().__init__(f"Invalid parameter '{parameter}': {message}")
        self.parameter = parameter


class TimeoutError(AnthropicError):
    timeout_seconds: int

    def __init__(self, timeout_seconds: int) -> None:
        super().__init__(f"Request timed out after {timeout_seconds} seconds")
        self.timeout_seconds = timeout_seconds

    def is_retryable(self) -> bool:
        return True


class ServerError(AnthropicError):
    status_code: int

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(f"Server error ({status_code}): {message}")
        self.status_code = status_code

    def is_retryable(self) -> bool:
        return True
