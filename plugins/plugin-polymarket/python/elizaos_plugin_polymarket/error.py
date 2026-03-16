from enum import Enum


class PolymarketErrorCode(str, Enum):
    INVALID_MARKET = "INVALID_MARKET"
    INVALID_TOKEN = "INVALID_TOKEN"  # noqa: S105
    INVALID_ORDER = "INVALID_ORDER"
    INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS"
    MARKET_CLOSED = "MARKET_CLOSED"
    API_ERROR = "API_ERROR"
    WEBSOCKET_ERROR = "WEBSOCKET_ERROR"
    AUTH_ERROR = "AUTH_ERROR"
    CONFIG_ERROR = "CONFIG_ERROR"
    CLIENT_NOT_INITIALIZED = "CLIENT_NOT_INITIALIZED"
    PARSE_ERROR = "PARSE_ERROR"
    NETWORK_ERROR = "NETWORK_ERROR"


class PolymarketError(Exception):
    def __init__(
        self,
        code: PolymarketErrorCode,
        message: str,
        cause: Exception | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.cause = cause

    def __str__(self) -> str:
        base = f"[{self.code.value}] {super().__str__()}"
        if self.cause:
            base += f" (caused by: {self.cause})"
        return base

    def __repr__(self) -> str:
        return f"PolymarketError(code={self.code!r}, message={super().__str__()!r})"

    @classmethod
    def invalid_market(cls, message: str) -> "PolymarketError":
        return cls(PolymarketErrorCode.INVALID_MARKET, message)

    @classmethod
    def invalid_token(cls, message: str) -> "PolymarketError":
        return cls(PolymarketErrorCode.INVALID_TOKEN, message)

    @classmethod
    def invalid_order(cls, message: str) -> "PolymarketError":
        return cls(PolymarketErrorCode.INVALID_ORDER, message)

    @classmethod
    def api_error(cls, message: str) -> "PolymarketError":
        return cls(PolymarketErrorCode.API_ERROR, message)

    @classmethod
    def config_error(cls, message: str) -> "PolymarketError":
        return cls(PolymarketErrorCode.CONFIG_ERROR, message)

    @classmethod
    def network_error(cls, message: str) -> "PolymarketError":
        return cls(PolymarketErrorCode.NETWORK_ERROR, message)

    @classmethod
    def parse_error(cls, message: str) -> "PolymarketError":
        return cls(PolymarketErrorCode.PARSE_ERROR, message)

    @classmethod
    def auth_error(cls, message: str) -> "PolymarketError":
        return cls(PolymarketErrorCode.AUTH_ERROR, message)
