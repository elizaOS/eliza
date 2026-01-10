"""
Error handling for the Polymarket plugin.
"""

from enum import Enum


class PolymarketErrorCode(str, Enum):
    """Polymarket-specific error codes."""

    INVALID_MARKET = "INVALID_MARKET"
    INVALID_TOKEN = "INVALID_TOKEN"
    INVALID_ORDER = "INVALID_ORDER"
    INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS"
    MARKET_CLOSED = "MARKET_CLOSED"
    API_ERROR = "API_ERROR"
    WEBSOCKET_ERROR = "WEBSOCKET_ERROR"
    AUTH_ERROR = "AUTH_ERROR"
    CONFIG_ERROR = "CONFIG_ERROR"
    CLIENT_NOT_INITIALIZED = "CLIENT_NOT_INITIALIZED"


class PolymarketError(Exception):
    """Polymarket-specific error with error code."""

    def __init__(
        self,
        code: PolymarketErrorCode,
        message: str,
        cause: Exception | None = None,
    ) -> None:
        """
        Initialize a Polymarket error.

        Args:
            code: The error code
            message: Human-readable error message
            cause: Optional underlying exception
        """
        super().__init__(message)
        self.code = code
        self.cause = cause

    def __str__(self) -> str:
        """Return string representation."""
        base = f"[{self.code.value}] {super().__str__()}"
        if self.cause:
            base += f" (caused by: {self.cause})"
        return base

    def __repr__(self) -> str:
        """Return repr representation."""
        return f"PolymarketError(code={self.code!r}, message={super().__str__()!r})"

