class RobloxError(Exception):
    pass


class ConfigError(RobloxError):
    pass


class ApiError(RobloxError):
    def __init__(
        self,
        message: str,
        status_code: int,
        endpoint: str,
        details: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.endpoint = endpoint
        self.details = details


class NetworkError(RobloxError):
    pass


class ValidationError(RobloxError):
    pass


class RateLimitError(RobloxError):
    def __init__(self, message: str, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after
