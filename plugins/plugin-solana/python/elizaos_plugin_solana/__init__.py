"""
elizaOS Solana Plugin - Solana blockchain operations for elizaOS agents.

This package provides:
- Wallet management and key derivation
- SOL and SPL token transfers
- Token swaps via Jupiter
- Portfolio tracking and balance queries

Example:
    >>> from elizaos_plugin_solana import SolanaClient, WalletConfig
    >>> config = WalletConfig.from_env()
    >>> client = SolanaClient(config)
    >>> balance = await client.get_sol_balance()
"""

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
]

# Plugin constants
PLUGIN_NAME = "chain_solana"
DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com"
WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"


