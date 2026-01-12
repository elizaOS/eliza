from enum import Enum


class EVMErrorCode(str, Enum):
    INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS"
    USER_REJECTED = "USER_REJECTED"
    NETWORK_ERROR = "NETWORK_ERROR"
    CONTRACT_REVERT = "CONTRACT_REVERT"
    GAS_ESTIMATION_FAILED = "GAS_ESTIMATION_FAILED"
    INVALID_PARAMS = "INVALID_PARAMS"
    CHAIN_NOT_CONFIGURED = "CHAIN_NOT_CONFIGURED"
    WALLET_NOT_INITIALIZED = "WALLET_NOT_INITIALIZED"
    TRANSACTION_FAILED = "TRANSACTION_FAILED"
    TOKEN_NOT_FOUND = "TOKEN_NOT_FOUND"  # noqa: S105
    ROUTE_NOT_FOUND = "ROUTE_NOT_FOUND"
    APPROVAL_FAILED = "APPROVAL_FAILED"


class EVMError(Exception):
    def __init__(
        self,
        code: EVMErrorCode,
        message: str,
        *,
        cause: Exception | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.cause = cause
        super().__init__(f"[{code.value}] {message}")

    @classmethod
    def insufficient_funds(cls, message: str) -> "EVMError":
        return cls(EVMErrorCode.INSUFFICIENT_FUNDS, message)

    @classmethod
    def chain_not_configured(cls, chain: str) -> "EVMError":
        return cls(EVMErrorCode.CHAIN_NOT_CONFIGURED, f"Chain '{chain}' is not configured")

    @classmethod
    def invalid_params(cls, message: str) -> "EVMError":
        return cls(EVMErrorCode.INVALID_PARAMS, message)

    @classmethod
    def wallet_not_initialized(cls) -> "EVMError":
        return cls(EVMErrorCode.WALLET_NOT_INITIALIZED, "Wallet not initialized")

    @classmethod
    def transaction_failed(cls, message: str) -> "EVMError":
        return cls(EVMErrorCode.TRANSACTION_FAILED, message)

    @classmethod
    def network_error(cls, message: str) -> "EVMError":
        return cls(EVMErrorCode.NETWORK_ERROR, message)

    @classmethod
    def route_not_found(cls, message: str) -> "EVMError":
        return cls(EVMErrorCode.ROUTE_NOT_FOUND, message)
