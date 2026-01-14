from __future__ import annotations


class OpenRouterError(Exception):
    pass


class ConfigError(OpenRouterError):
    pass


class ApiKeyError(OpenRouterError):
    def __init__(self, message: str | None = None) -> None:
        super().__init__(
            message or "OPENROUTER_API_KEY is not set. Please set it to your OpenRouter API key."
        )


class NetworkError(OpenRouterError):
    def __init__(self, message: str, status_code: int | None = None) -> None:
        self.status_code = status_code
        super().__init__(message)


class RateLimitError(OpenRouterError):
    def __init__(self, retry_after_seconds: int = 60) -> None:
        self.retry_after_seconds = retry_after_seconds
        super().__init__(f"Rate limit exceeded. Retry after {retry_after_seconds} seconds.")
