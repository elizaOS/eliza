"""
elizaOS EVM Plugin - Ethereum Virtual Machine interaction for elizaOS.

This package provides EVM blockchain adapters for elizaOS agents using
web3.py for interacting with various EVM-compatible networks.

Features:
- Multi-chain wallet management
- Native and ERC20 token transfers
- Token swaps using LiFi aggregator
- Cross-chain bridges using LiFi
- Strong type validation with Pydantic
"""

__version__ = "0.1.0"

from elizaos_plugin_evm.actions import (
    bridge_action,
    execute_bridge,
    execute_swap,
    execute_transfer,
    swap_action,
    transfer_action,
)
from elizaos_plugin_evm.constants import (
    CACHE_REFRESH_INTERVAL_SECS,
    EVM_SERVICE_NAME,
    EVM_WALLET_DATA_CACHE_KEY,
    LIFI_API_URL,
    NATIVE_TOKEN_ADDRESS,
)
from elizaos_plugin_evm.error import EVMError, EVMErrorCode
from elizaos_plugin_evm.providers import EVMWalletProvider
from elizaos_plugin_evm.providers.wallet import GeneratedKey, generate_private_key
from elizaos_plugin_evm.types import (
    BridgeParams,
    BridgeStatus,
    BridgeStatusType,
    SupportedChain,
    SwapParams,
    SwapQuote,
    TokenInfo,
    TokenWithBalance,
    TransferParams,
    VoteParams,
    VoteType,
    WalletBalance,
)

__all__ = [
    # Version
    "__version__",
    # Provider
    "EVMWalletProvider",
    # Key generation
    "GeneratedKey",
    "generate_private_key",
    # Types
    "SupportedChain",
    "TokenInfo",
    "TokenWithBalance",
    "WalletBalance",
    "TransferParams",
    "SwapParams",
    "SwapQuote",
    "BridgeParams",
    "BridgeStatus",
    "BridgeStatusType",
    "VoteParams",
    "VoteType",
    # Error handling
    "EVMError",
    "EVMErrorCode",
    # Actions
    "execute_transfer",
    "transfer_action",
    "execute_swap",
    "swap_action",
    "execute_bridge",
    "bridge_action",
    # Constants
    "EVM_SERVICE_NAME",
    "EVM_WALLET_DATA_CACHE_KEY",
    "CACHE_REFRESH_INTERVAL_SECS",
    "NATIVE_TOKEN_ADDRESS",
    "LIFI_API_URL",
]


# Plugin definition for elizaOS
def get_plugin():
    """Get the EVM plugin definition for elizaOS."""
    return {
        "name": "@elizaos/plugin-evm",
        "description": "EVM blockchain plugin for elizaOS with Python support",
        "version": __version__,
        "actions": [
            transfer_action,
            swap_action,
            bridge_action,
        ],
        "providers": [
            EVMWalletProvider,
        ],
    }
