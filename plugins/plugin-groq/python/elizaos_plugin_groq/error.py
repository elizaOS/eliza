import re
from enum import Enum


class GroqErrorCode(str, Enum):
    INVALID_API_KEY = "INVALID_API_KEY"
    RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED"
    INVALID_REQUEST = "INVALID_REQUEST"
    SERVER_ERROR = "SERVER_ERROR"
    PARSE_ERROR = "PARSE_ERROR"


class GroqError(Exception):
    def __init__(
        self,
        message: str,
        code: GroqErrorCode = GroqErrorCode.INVALID_REQUEST,
        status_code: int | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code
        self.retry_after = retry_after

    @property
    def is_retryable(self) -> bool:
        return self.code == GroqErrorCode.RATE_LIMIT_EXCEEDED

    @property
    def retry_delay_ms(self) -> int | None:
        if self.retry_after:
            return int(self.retry_after * 1000) + 1000
        if self.code == GroqErrorCode.RATE_LIMIT_EXCEEDED:
            return 10000
        return None

    @classmethod
    def from_response(cls, status_code: int, body: str) -> "GroqError":
        if status_code == 401:
            return cls(
                message="Invalid API key",
                code=GroqErrorCode.INVALID_API_KEY,
                status_code=status_code,
            )

        if status_code == 429:
            retry_after = _extract_retry_delay(body)
            return cls(
                message=body,
                code=GroqErrorCode.RATE_LIMIT_EXCEEDED,
                status_code=status_code,
                retry_after=retry_after,
            )

        code = GroqErrorCode.SERVER_ERROR if status_code >= 500 else GroqErrorCode.INVALID_REQUEST
        return cls(message=body, code=code, status_code=status_code)


def _extract_retry_delay(message: str) -> float | None:
    match = re.search(r"try again in (\d+\.?\d*)s", message, re.IGNORECASE)
    if match:
        return float(match.group(1))
    return None
