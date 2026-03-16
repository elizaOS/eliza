class SolanaError(Exception):
    """Base error for Solana operations."""

    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)


class ConfigError(SolanaError):
    """Configuration error - missing or invalid settings."""

    pass


class InvalidKeypairError(SolanaError):
    """Invalid keypair or key format."""

    pass


class InvalidPublicKeyError(SolanaError):
    """Invalid public key format."""

    pass


class InvalidMintError(SolanaError):
    """Invalid mint address."""

    pass


class RpcError(SolanaError):
    """RPC connection error."""

    pass


class TransactionError(SolanaError):
    """Transaction error."""

    pass


class SimulationError(SolanaError):
    """Transaction simulation failed."""

    pass


class ConfirmationTimeoutError(SolanaError):
    """Transaction confirmation timeout."""

    pass


class InsufficientBalanceError(SolanaError):
    """Insufficient balance for operation."""

    def __init__(self, required: int, available: int) -> None:
        self.required = required
        self.available = available
        super().__init__(f"Insufficient balance: required {required}, available {available}")


class TokenAccountNotFoundError(SolanaError):
    """Token account not found."""

    def __init__(self, mint: str) -> None:
        self.mint = mint
        super().__init__(f"Token account not found for mint {mint}")


class SwapError(SolanaError):
    """Swap quote or execution error."""

    pass


class RateLimitedError(SolanaError):
    """Rate limited by RPC or API."""

    pass


class AccountNotFoundError(SolanaError):
    """Account not found."""

    pass
