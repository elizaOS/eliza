# Actions
from elizaos_plugin_solana.actions import (
    SWAP_ACTION,
    TRANSFER_ACTION,
    SwapActionResult,
    TransferActionResult,
    handle_swap,
    handle_transfer,
)
from elizaos_plugin_solana.client import SolanaClient
from elizaos_plugin_solana.config import WalletConfig
from elizaos_plugin_solana.errors import (
    ConfigError,
    InsufficientBalanceError,
    InvalidKeypairError,
    InvalidPublicKeyError,
    RpcError,
    SolanaError,
    SwapError,
    TransactionError,
)
from elizaos_plugin_solana.keypair import KeypairUtils

# Providers
from elizaos_plugin_solana.providers import (
    WALLET_PROVIDER,
    WalletProviderResult,
    get_wallet_portfolio,
)
from elizaos_plugin_solana.service import SolanaService, SolanaWalletService
from elizaos_plugin_solana.types import (
    PortfolioItem,
    PriceInfo,
    Prices,
    SwapQuote,
    SwapQuoteParams,
    SwapResult,
    TokenAccountInfo,
    TransferParams,
    TransferResult,
    WalletPortfolio,
)

__version__ = "1.2.6"
__all__ = [
    # Client
    "SolanaClient",
    # Configuration
    "WalletConfig",
    # Keypair utilities
    "KeypairUtils",
    # Types
    "PortfolioItem",
    "PriceInfo",
    "Prices",
    "SwapQuote",
    "SwapQuoteParams",
    "SwapResult",
    "TokenAccountInfo",
    "TransferParams",
    "TransferResult",
    "WalletPortfolio",
    # Errors
    "SolanaError",
    "ConfigError",
    "InvalidKeypairError",
    "InvalidPublicKeyError",
    "RpcError",
    "TransactionError",
    "InsufficientBalanceError",
    "SwapError",
    # Actions
    "SWAP_ACTION",
    "TRANSFER_ACTION",
    "SwapActionResult",
    "TransferActionResult",
    "handle_swap",
    "handle_transfer",
    # Providers
    "WALLET_PROVIDER",
    "WalletProviderResult",
    "get_wallet_portfolio",
    # Services
    "SolanaService",
    "SolanaWalletService",
]

PLUGIN_NAME = "chain_solana"
DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com"
WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
