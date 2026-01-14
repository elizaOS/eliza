from __future__ import annotations


class FarcasterError(Exception):
    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)


class ConfigError(FarcasterError):
    pass


class ValidationError(FarcasterError):
    pass


class NetworkError(FarcasterError):
    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class ApiError(FarcasterError):
    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        error_code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code


class RateLimitError(ApiError):
    """Raised when API rate limit is exceeded."""

    def __init__(
        self,
        message: str = "Rate limit exceeded",
        retry_after: int | None = None,
    ) -> None:
        super().__init__(message, status_code=429, error_code="rate_limit_exceeded")
        self.retry_after = retry_after


class CastError(FarcasterError):
    pass


class ProfileError(FarcasterError):
    pass
